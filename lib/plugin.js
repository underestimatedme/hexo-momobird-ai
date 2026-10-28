'use strict';

// Connects the other modules to Hexo: three filters that sync and decorate
// during `hexo generate` / `hexo deploy`, and the `hexo momobird` command.
//
// Where things happen:
//   before_generate   asks MomoBird for the status, checks the site address and
//                     registers the widget / podcast markup
//   template_locals   puts the podcast placeholder on post pages
//   after_generate    syncs the posts, then switches the widget on if needed
//
// Failures never stop a build unless `strict: true`. Then the filter's promise
// rejects with an Error carrying the same Chinese text that would have been
// logged, which makes `hexo generate` exit non-zero.
//
// The `momobird` command reports its own failures differently: it prints the
// reason with log.error and sets process.exitCode to 1 (through
// deps.setExitCode, so tests can observe it), instead of throwing. A thrown
// error would make hexo-cli add its "Something's wrong" banner and a stack
// trace to what is a plain usage problem such as a missing key.

const { readConfig, booleanOf, ConfigError } = require('./config');
const { autoRunEnabled } = require('./command');
const { externalId } = require('./post-id');
const { isSyncable, exclusionOf, collectLocal, listPostFiles } = require('./posts');
const { createClient: connectClient, describeError } = require('./client');
const { cachePath } = require('./cache');
const { runSync } = require('./reconcile');
const { widgetSnippet, podcastScriptTag, podcastPlaceholder, decoratePostLocals } = require('./frontend');

const PREFIX = '[MomoBird] ';
const MIN_HEXO_MAJOR = 5;
const MAX_TEXT_CHARS = 200;
const MAX_LISTED = 30;

// The source id comes from the server and ends up in a file name and in page
// markup, so it is only used when it is a plain UUID.
const SOURCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_SHAPE = /mbk_[A-Za-z0-9_-]*/g;

const USAGE = '用法：hexo momobird <status|sync> [--dry-run] [--prune]';
const SOURCE_PROBLEM = 'MomoBird 返回的来源信息格式不正确';
const NOT_HEXO_HINTS = {
  sync: '，请确认连的是 Hexo 来源；继续推送，但不下线任何文章',
  prune: '，请确认连的是 Hexo 来源；按 --prune 继续，会下线本地已没有的文章',
  status: '，请确认连的是 Hexo 来源；同步时只推送、不下线文章（除非加 --prune）'
};

// Why a post Hexo read is not on the site's list for MomoBird (exclusionOf).
const EXCLUSION_TEXT = {
  draft: '草稿',
  unpublished: '未发布',
  encrypted: '加密',
  hidden: '隐藏',
  opted_out: 'momobird: false',
  scheduled: '未到发布时间'
};

const WIDGET_REASONS = {
  not_published: '还没上线（配置 widget: true 后，下次构建会自动开启）',
  disabled_in_console: '已在 MomoBird 控制台关闭',
  plan_required: '套餐已到期',
  origin_not_registered: '站点地址还没登记到 MomoBird'
};

// Raised for a failure that should stop a strict build. Anything else thrown
// inside a filter is a bug or an unexpected error and is handled by `safely`.
class StrictFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'MomoBirdError';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Text that came from outside (names, paths, reasons): one line, no control
// characters, not absurdly long.
function clean(value) {
  const text = String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) + '…' : text;
}

function shown(value) {
  const text = clean(value);
  return text === '' ? '（未设置）' : text;
}

// `scheme://host[:port]`, lowercased, or null when the value is not a URL with
// a real origin.
function originOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const origin = new URL(value.trim()).origin;
    return origin === 'null' ? null : origin.toLowerCase();
  } catch (err) {
    return null;
  }
}

function hexoMajor(version) {
  return parseInt(String(version).split('.')[0], 10);
}

function dateOf(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
}

function planText(entitlement) {
  if (!isObject(entitlement)) return '未知';
  const ends = dateOf(entitlement.status === 'pro' ? entitlement.pro_ends_at : entitlement.trial_ends_at);
  if (entitlement.active === false || entitlement.status === 'expired') {
    return ends === '' ? '已到期' : '已到期（' + ends + '）';
  }
  const suffix = ends === '' ? '' : '，' + ends + ' 到期';
  if (entitlement.status === 'pro') return '专业版' + suffix;
  if (entitlement.status === 'trial') return '试用中' + suffix;
  return '未知';
}

function widgetText(widget) {
  if (!isObject(widget)) return '未知';
  if (widget.available === true) return '可用';
  const reason = widget.reason;
  if (typeof reason === 'string' && Object.prototype.hasOwnProperty.call(WIDGET_REASONS, reason)) {
    return WIDGET_REASONS[reason];
  }
  return typeof reason === 'string' && reason !== '' ? '不可用（' + clean(reason) + '）' : '不可用';
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? String(value) : '未知';
}

const SWITCHES = [
  { flag: '--dry-run', names: ['dry-run', 'dry_run', 'dryRun'] },
  { flag: '--prune', names: ['prune'] }
];

// One command-line switch. hexo-cli parses the line with minimist, which gives
// true for `--prune`, '' for `--prune=` and 'true' for `--prune true`; only
// those switch it on. Anything else (`--prune=no`, `--prune=0`, `--no-prune`,
// a repeated flag) is not understood and comes back as { bad: value }: it must
// stop the command, because a "no" read as yes would remove posts without the
// guard, and read as no would hide a typo.
function readSwitch(args, names) {
  const source = isObject(args) ? args : {};
  let on = false;
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(source, name)) continue;
    const value = source[name];
    if (value === undefined) continue;
    if (value === true || value === '' || value === 'true') on = true;
    else return { on: false, bad: value };
  }
  return { on };
}

function switchValueText(value) {
  if (Array.isArray(value)) return '写了 ' + value.length + ' 次';
  return typeof value === 'string' ? JSON.stringify(clean(value)) : clean(value);
}

// The switches of `hexo momobird sync`, or a usage error text.
function syncSwitches(args) {
  const found = {};
  for (const item of SWITCHES) {
    const value = readSwitch(args, item.names);
    if (Object.prototype.hasOwnProperty.call(value, 'bad')) {
      return {
        error:
          '参数 ' + item.flag + ' 的值无法识别（' + switchValueText(value.bad) + '），已停止，没有同步任何文章。' +
          '要用这个参数就只写 ' + item.flag + '，不用就不写。' + USAGE
      };
    }
    found[item.flag] = value.on;
  }
  return { dryRun: found['--dry-run'], prune: found['--prune'] };
}

// `hexo momobird sync` reaches the handler as { _: ['sync'] }; tolerate the
// command name still being in front.
function subcommandOf(args) {
  const words = isObject(args) && Array.isArray(args._) ? args._.map(String) : [];
  if (words[0] === 'momobird') words.shift();
  return words.length > 0 ? words[0] : '';
}

function pairText(pairs) {
  const shownPairs = pairs.slice(0, 3).map((pair) => clean(pair[0]) + ' 和 ' + clean(pair[1]));
  return shownPairs.join('、') + (pairs.length > 3 ? ' 等 ' + pairs.length + ' 组' : '');
}

function duplicatesText(pairs) {
  return '有文章算出了同一个编号（' + pairText(pairs) + '），已中止同步，请给其中一篇改个文件名或换个目录';
}

function register(hexo, deps) {
  const options = deps || {};
  const createClient = options.createClient || connectClient;
  const now = options.now || (() => new Date());
  const env = options.env || process.env;
  const setExitCode =
    options.setExitCode ||
    ((code) => {
      process.exitCode = code;
    });

  // ----- logging -----------------------------------------------------------

  // Every line is prefixed and has the key (and anything key-shaped) removed,
  // whatever text it was built from.
  function format(text) {
    let line = String(text);
    const key = typeof env.MOMOBIRD_KEY === 'string' ? env.MOMOBIRD_KEY.trim() : '';
    if (key !== '') line = line.split(key).join('***');
    line = line.replace(KEY_SHAPE, '***');
    return line.indexOf(PREFIX) === 0 ? line : PREFIX + line;
  }

  function write(level, text) {
    hexo.log[level](format(text));
  }

  // Also the logger handed to runSync, whose lines already carry the prefix.
  const log = {
    info: (text) => write('info', text),
    warn: (text) => write('warn', text),
    error: (text) => write('error', text)
  };

  if (!(hexoMajor(hexo.version) >= MIN_HEXO_MAJOR)) {
    log.warn('需要 Hexo 5 或更高版本');
    return;
  }

  // ----- shared pieces -----------------------------------------------------

  let state = emptyState();
  let noKeyNoticeShown = false;
  let localsFailureShown = false;
  const injected = new Set();
  const configWarningsShown = new Set();

  function emptyState() {
    return { ready: false, config: null, client: null, status: null, sourceId: null, hexoSource: false };
  }

  function autoRun() {
    return autoRunEnabled({
      cmd: String(hexo.env.cmd || '').toLowerCase(),
      args: hexo.env.args,
      aliases: hexo.extend.console.alias
    });
  }

  function rawStrict() {
    const section = hexo.config ? hexo.config.momobird : undefined;
    return isObject(section) && booleanOf(section.strict) === true;
  }

  // The config with its warnings (option values that are not understood)
  // logged once per process, however many builds or commands read it.
  function loadConfig() {
    return readConfig(hexo.config, env, (text) => {
      if (configWarningsShown.has(text)) return;
      configWarningsShown.add(text);
      write('warn', text);
    });
  }

  // Hexo shows future-dated posts only when `future` is truthy
  // (`!this.config.future` hides them), so `future:` left empty or `future: 0`
  // hides them too.
  function syncOptions() {
    return { future: Boolean(hexo.config.future), now: now() };
  }

  // The categories of a post in the order its author wrote them. post.categories
  // is in site-wide creation order, which is neither that order nor the same
  // from one build to the next, so the post's own PostCategory rows are read:
  // they are stored in front-matter order. A row whose category is gone is
  // skipped.
  function categoriesOf(post) {
    const Category = hexo.model('Category');
    const found = [];
    for (const row of hexo.model('PostCategory').find({ post_id: post._id }).toArray()) {
      const category = Category.findById(row.category_id);
      if (category) found.push(category);
    }
    return found;
  }

  function collectLocalPosts() {
    const posts = hexo.model('Post').find({ published: true }).toArray();
    return collectLocal(posts, Object.assign(syncOptions(), { categoriesOf }));
  }

  // Every post Hexo read, in any state (drafts, hidden, encrypted ...), by id.
  function postsById() {
    const byId = new Map();
    for (const post of hexo.model('Post').toArray()) {
      if (typeof post.source === 'string' && post.source !== '') byId.set(externalId(post.source), post);
    }
    return byId;
  }

  // Post files under source/_posts that Hexo did not read: when it cannot
  // parse a post (a front-matter typo, say) it logs "Process failed" and goes
  // on without it, so the post is simply missing. Such a post must not be
  // taken down: back after the fix, it would be a new document in MomoBird
  // and lose its podcast. A Map of id to the source path for the log.
  function unreadablePosts() {
    const read = postsById();
    const missing = new Map();
    for (const source of listPostFiles(hexo.source_dir, (file) => hexo.render.isRenderable(file))) {
      const id = externalId(source);
      if (!read.has(id) && !missing.has(id)) missing.set(id, clean(source));
    }
    return missing;
  }

  // The status the build or the command works from, checked for the parts
  // used later. Null when the source part is unusable.
  function sourceOf(status) {
    const source = isObject(status) ? status.source : null;
    if (!isObject(source) || typeof source.id !== 'string' || !SOURCE_ID_PATTERN.test(source.id)) return null;
    return source;
  }

  // A source of another kind holds posts another platform pushed. They are
  // never taken down unless --prune says so.
  function isHexoSource(source) {
    return source.kind === 'hexo';
  }

  // mode: 'sync' (a build, or the command without --prune), 'prune' or 'status'.
  function kindHint(source, mode) {
    return '这个知识源的类型是 ' + (typeof source.kind === 'string' ? clean(source.kind) : '未知') +
      '，不是 hexo' + NOT_HEXO_HINTS[mode];
  }

  function withheldText(report) {
    return (
      'MomoBird 上有 ' + report.withheld + ' 篇文章本地没有，因为知识源不是 hexo 类型，本次没有下线。' +
      '确认要下线，请运行 hexo momobird sync --prune'
    );
  }

  function compareOrigins(source) {
    const site = originOf(hexo.config.url);
    const remote = originOf(source.site_url);
    return {
      ok: site !== null && remote !== null && site === remote,
      origin: site,
      siteText: shown(hexo.config.url),
      remoteText: shown(source.site_url)
    };
  }

  function originProblem(check, consequence) {
    return (
      '站点地址不一致：_config.yml 里的 url 是 ' + check.siteText + '，MomoBird 来源的网址是 ' + check.remoteText +
      '。两边必须同源（协议、域名、端口都一样，注意 www 和 http/https）。' + consequence
    );
  }

  // Strict builds stop with the text; others only see it in the log.
  function problem(strict, level, text) {
    if (strict) throw new StrictFailure(format(text));
    write(level, text);
  }

  // Runs a filter body so that only a StrictFailure can escape from a lenient
  // build; anything unexpected becomes a warning.
  async function safely(isStrict, body) {
    try {
      return await body();
    } catch (err) {
      if (err instanceof StrictFailure) throw err;
      const text = '遇到意外错误：' + describeError(err);
      if (isStrict()) throw new StrictFailure(format(text));
      write('warn', text);
      return undefined;
    }
  }

  function inject(entry, value, to) {
    const id = entry + '\n' + to + '\n' + value;
    if (injected.has(id)) return;
    injected.add(id);
    hexo.extend.injector.register(entry, value, to);
  }

  // The summary line and one line per post MomoBird did not take. Returns the
  // number of refused posts. After a 402 the summary is expiredText instead,
  // which the caller reports as a failure.
  function logOutcome(report) {
    if (report.planRequired.length === 0) {
      log.info(
        '同步完成：新增或更新 ' + report.pushed + ' 篇，未变 ' + report.unchanged + ' 篇，下线 ' + report.removed +
          ' 篇，失败 ' + report.rejected.length + ' 篇'
      );
    }
    for (const item of report.rejected) {
      log.warn('同步失败：' + clean(item.source) + '（' + clean(item.code) + '）');
    }
    return report.rejected.length;
  }

  // What a sync that met a 402 did: new and changed posts were not sent, the
  // removals still were.
  function expiredText(report) {
    let text =
      '同步未完成：套餐已到期，新增或修改的 ' + report.planRequired.length + ' 篇文章没有同步' +
      '（开通专业版或续费后，下次同步会补齐）；删除、隐藏的文章照常下线，本次下线 ' + report.removed + ' 篇';
    if (report.pushed + report.unchanged > 0) {
      text += '，到期前已推送 ' + (report.pushed + report.unchanged) + ' 篇';
    }
    return text;
  }

  // ----- before_generate ---------------------------------------------------

  async function beforeGenerate() {
    state = emptyState();
    if (!autoRun()) return;

    let strict = rawStrict();
    await safely(() => strict, async () => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        return problem(strict, 'error', err instanceof ConfigError ? err.message : '读取配置失败：' + describeError(err));
      }
      strict = config.strict;

      // Nothing to do (`momobird: false`, or every feature switched off).
      if (!config.sync && !config.widget && !config.podcast) return undefined;

      if (config.key === null) {
        if (!noKeyNoticeShown) {
          noKeyNoticeShown = true;
          log.info('未设置 MOMOBIRD_KEY，跳过同步');
        }
        return undefined;
      }

      let client;
      let status;
      try {
        client = createClient({ api: config.api, key: config.key });
        status = await client.status();
      } catch (err) {
        return problem(
          strict,
          'warn',
          '无法获取 MomoBird 状态，本次构建不同步，也不输出问答助手和播客播放器：' + describeError(err)
        );
      }

      const source = sourceOf(status);
      if (source === null) {
        return problem(strict, 'error', SOURCE_PROBLEM + '，本次构建不同步，也不输出问答助手和播客播放器');
      }
      if (!isHexoSource(source)) log.warn(kindHint(source, 'sync'));

      const check = compareOrigins(source);
      if (!check.ok) {
        return problem(strict, 'error', originProblem(check, '本次构建不同步，也不输出问答助手和播客播放器'));
      }

      if (config.widget) {
        const widget = isObject(status.widget) ? status.widget : {};
        const snippet = widgetSnippet(widget.public_id, config.widgetPosition);
        if (snippet === '') {
          log.warn('MomoBird 没有返回可用的问答助手编号，本次不输出问答助手');
        } else {
          inject('body_end', snippet, 'default');
        }
      }
      if (config.podcast) {
        inject('body_end', podcastScriptTag(), 'post');
      }

      state = { ready: true, config, client, status, sourceId: source.id, hexoSource: isHexoSource(source) };
      return undefined;
    });
  }

  // ----- template_locals ---------------------------------------------------

  function templateLocals(locals) {
    if (!state.ready || !state.config.podcast) return locals;
    const { config, sourceId } = state;

    try {
      return decoratePostLocals(locals, (page) => {
        if (typeof page.source !== 'string' || page.source === '') return '';
        if (!isSyncable(page, syncOptions())) return '';
        return podcastPlaceholder({
          sourceId,
          externalId: externalId(page.source),
          api: config.api,
          transcript: config.podcastTranscript
        });
      });
    } catch (err) {
      const text = '无法给文章页加上播客播放器：' + describeError(err);
      if (config.strict) throw new StrictFailure(format(text));
      if (!localsFailureShown) {
        localsFailureShown = true;
        write('warn', text);
      }
      return locals;
    }
  }

  // ----- after_generate ----------------------------------------------------

  async function afterGenerate() {
    if (!state.ready) return;
    const { config, client, status, sourceId, hexoSource } = state;

    await safely(() => config.strict, async () => {
      // Failures of this build. A lenient build logs each as it happens; a
      // strict one stops at the end with all of them in the error.
      const failures = [];
      const fail = (text, level) => {
        failures.push(text);
        if (!config.strict) write(level || 'warn', text);
      };

      let synced = true;
      if (config.sync) {
        synced = false;
        try {
          const local = collectLocalPosts();
          if (local.duplicates.length > 0) {
            fail(duplicatesText(local.duplicates), 'error');
          } else {
            const report = await runSync({
              client,
              local: local.items,
              unreadable: unreadablePosts(),
              cacheFile: cachePath(hexo.base_dir, sourceId),
              prune: false,
              holdRemovals: !hexoSource,
              dryRun: false,
              log
            });
            synced = report.planRequired.length === 0;
            if (report.withheld > 0) log.warn(withheldText(report));
            const refused = logOutcome(report);
            if (refused > 0) failures.push(refused + ' 篇文章被 MomoBird 拒绝，下次构建会再试');
            if (!synced) fail(expiredText(report));
          }
        } catch (err) {
          fail('同步失败：' + describeError(err));
        }
      }

      const widget = isObject(status.widget) ? status.widget : {};
      if (config.widget && synced && widget.reason === 'not_published') {
        try {
          await client.enableWidget();
          log.info('已开启问答助手');
        } catch (err) {
          if (err && err.kind === 'http' && err.status === 409) {
            log.info('问答助手暂时无法开启，下次构建会自动再试：' + describeError(err));
          } else {
            fail('开启问答助手失败：' + describeError(err));
          }
        }
      }

      if (config.strict && failures.length > 0) {
        throw new StrictFailure(format(failures.join('；')));
      }
    });
  }

  // ----- hexo momobird -----------------------------------------------------

  function failCommand(text) {
    write('error', text);
    setExitCode(1);
  }

  // Reads the config, asks for the status and checks it. Returns null after
  // printing the reason and flagging the failure.
  async function openSession(subcommand, switches) {
    let config;
    try {
      config = loadConfig();
    } catch (err) {
      failCommand(err instanceof ConfigError ? err.message : '读取配置失败：' + describeError(err));
      return null;
    }
    if (config.key === null) {
      failCommand('未设置 MOMOBIRD_KEY，无法运行 hexo momobird ' + subcommand + '。请把连接密钥放进环境变量 MOMOBIRD_KEY');
      return null;
    }

    let client;
    let status;
    try {
      client = createClient({ api: config.api, key: config.key });
      status = await client.status();
    } catch (err) {
      failCommand('无法获取 MomoBird 状态：' + describeError(err));
      return null;
    }

    const source = sourceOf(status);
    if (source === null) {
      failCommand(SOURCE_PROBLEM + '，已停止');
      return null;
    }
    if (!isHexoSource(source)) {
      log.warn(kindHint(source, subcommand === 'status' ? 'status' : switches.prune ? 'prune' : 'sync'));
    }

    return { config, client, status, source, check: compareOrigins(source) };
  }

  function showStatus(session) {
    const { status, source, check } = session;
    const project = isObject(status.project) ? status.project : {};

    log.info('项目：' + shown(project.name));
    log.info('来源：' + shown(source.name) + '（类型 ' + (typeof source.kind === 'string' ? clean(source.kind) : '未知') + '）');
    log.info('套餐：' + planText(status.entitlement));
    log.info('问答助手：' + widgetText(status.widget));
    log.info('站点地址：' + (check.ok ? '一致（' + check.origin + '）' : '不一致'));

    const local = collectLocalPosts();
    let line = '文章：本地 ' + local.items.size + ' 篇，MomoBird 上 ' + count(source.document_count) + ' 篇';
    if (Number.isInteger(source.ready_document_count) && source.ready_document_count < source.document_count) {
      line += '（其中 ' + source.ready_document_count + ' 篇已建好索引）';
    }
    log.info(line);

    if (!check.ok) failCommand(originProblem(check, '这样同步会被 MomoBird 拒绝'));
    if (local.duplicates.length > 0) failCommand(duplicatesText(local.duplicates));
  }

  // How a planned removal is named: the title (and url) MomoBird listed, else
  // the post Hexo read and why it stays out, else just the id.
  function removalText(id, listed, post) {
    if (listed) {
      const name = clean(listed.title || listed.url);
      return listed.title && listed.url ? name + '（' + clean(listed.url) + '）' : name;
    }
    if (post) {
      const reason = exclusionOf(post, syncOptions());
      return clean(post.source) + '（' + (reason === null ? '正文为空' : EXCLUSION_TEXT[reason]) + '）';
    }
    return '编号 ' + clean(id) + '（本地找不到对应文件）';
  }

  function listPlan(report, items) {
    const lines = [];
    for (const id of report.planned.push) {
      lines.push('将推送：' + clean(items.get(id).source));
    }
    const read = report.planned.remove.length > 0 ? postsById() : new Map();
    for (const id of report.planned.remove) {
      lines.push('将下线：' + removalText(id, report.listed.get(id), read.get(id)));
    }
    for (const line of lines.slice(0, MAX_LISTED)) log.info(line);
    if (lines.length > MAX_LISTED) log.info('……还有 ' + (lines.length - MAX_LISTED) + ' 项没有列出');
  }

  async function manualSync(session, switches) {
    const { client, source, check } = session;
    const { dryRun, prune } = switches;

    if (!check.ok) {
      failCommand(originProblem(check, '已跳过同步'));
      return;
    }

    const local = collectLocalPosts();
    if (local.duplicates.length > 0) {
      failCommand(duplicatesText(local.duplicates));
      return;
    }

    let report;
    try {
      report = await runSync({
        client,
        local: local.items,
        unreadable: unreadablePosts(),
        cacheFile: cachePath(hexo.base_dir, source.id),
        prune,
        holdRemovals: !prune && !isHexoSource(source),
        dryRun,
        log
      });
    } catch (err) {
      failCommand('同步失败：' + describeError(err));
      return;
    }

    if (report.withheld > 0) log.warn(withheldText(report));
    if (dryRun) {
      listPlan(report, local.items);
      return;
    }
    if (logOutcome(report) > 0) setExitCode(1);
    if (report.planRequired.length > 0) failCommand(expiredText(report));
  }

  async function momobirdCommand(args) {
    const subcommand = subcommandOf(args);
    if (subcommand !== 'status' && subcommand !== 'sync') {
      failCommand(USAGE);
      return;
    }
    const switches = subcommand === 'sync' ? syncSwitches(args) : {};
    if (switches.error) {
      failCommand(switches.error);
      return;
    }

    await hexo.load();
    try {
      const session = await openSession(subcommand, switches);
      if (session === null) return;
      if (subcommand === 'status') {
        showStatus(session);
      } else {
        await manualSync(session, switches);
      }
    } catch (err) {
      failCommand('遇到意外错误：' + describeError(err));
    }
  }

  // ----- registration ------------------------------------------------------

  hexo.extend.filter.register('before_generate', beforeGenerate);
  hexo.extend.filter.register('template_locals', templateLocals);
  hexo.extend.filter.register('after_generate', afterGenerate);

  hexo.extend.console.register(
    'momobird',
    'MomoBird 同步工具',
    {
      usage: '<status|sync>',
      options: [
        { name: '--dry-run', desc: '只列出将要推送和下线的文章，不发送任何改动' },
        { name: '--prune', desc: '跳过清理保护，下线本地已没有的文章' }
      ]
    },
    momobirdCommand
  );
}

module.exports = { register };
