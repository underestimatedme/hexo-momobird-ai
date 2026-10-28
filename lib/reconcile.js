'use strict';

// Decides which posts to push to MomoBird and which to take down, and does it.
// The remote listing is the truth about what MomoBird holds; the cache only
// says which version of a post MomoBird already accepted.

const { ConnectError } = require('./client');
const { readCache, writeCache } = require('./cache');

const PUSH_BATCH_SIZE = 20;
const DELETE_BATCH_SIZE = 100;
// Without --prune, taking down more than this many posts needs a second look
// when it is also more than half of what MomoBird holds.
const PRUNE_GUARD_MIN_REMOVALS = 10;

const PREFIX = '[MomoBird] ';
const CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// push: ids missing from MomoBird, plus ids whose cached digest differs, in
// local order. remove: ids MomoBird holds that the site no longer has, in
// remote order. held: ids MomoBird holds whose file is still on disk but that
// Hexo could not read (input.unreadable, a Map of id to source path); they are
// never removed, whatever --prune says. The prune guard turns a suspicious
// `remove` into [] (a blog that suddenly looks empty or tiny is more likely a
// broken build than a deliberate purge).
function planSync(input) {
  const { local, remoteIds, cache, prune } = input;
  const unreadable = input.unreadable || new Map();

  const push = [];
  for (const [id, post] of local) {
    const cached = hasOwn(cache, id) ? cache[id] : undefined;
    if (!remoteIds.has(id) || cached !== post.digest) {
      push.push(id);
    }
  }

  let remove = [];
  const held = [];
  for (const id of remoteIds) {
    if (local.has(id)) continue;
    if (unreadable.has(id)) held.push(id);
    else remove.push(id);
  }

  let pruneSkipped = false;
  if (!prune && remove.length > 0) {
    const siteIsEmpty = local.size === 0;
    const wholesale = remove.length > PRUNE_GUARD_MIN_REMOVALS && remove.length * 2 > remoteIds.size;
    if (siteIsEmpty || wholesale) {
      remove = [];
      pruneSkipped = true;
    }
  }

  return { push, remove, pruneSkipped, held };
}

function malformed(reason) {
  return new ConnectError({ kind: 'network', reason });
}

// What the listing says about a post besides its id, for the dry-run list:
// its title and url, when the server sends them (today it sends neither).
function listedInfo(item) {
  const info = {};
  if (typeof item.title === 'string' && item.title.trim() !== '') info.title = item.title;
  if (typeof item.url === 'string' && item.url.trim() !== '') info.url = item.url;
  return info.title === undefined && info.url === undefined ? null : info;
}

// Reads every page of the remote listing: { ids, info }, info holding
// listedInfo by id where there is any. A server that keeps handing back a
// cursor it has already sent would otherwise hold the build forever.
async function listRemote(client) {
  const ids = new Set();
  const info = new Map();
  const seen = new Set();
  let cursor;
  for (;;) {
    const page = await client.listPosts(cursor);
    if (page === null || typeof page !== 'object' || !Array.isArray(page.items)) {
      throw malformed('文章列表的响应格式不正确');
    }
    for (const item of page.items) {
      if (item !== null && typeof item === 'object' && typeof item.external_id === 'string') {
        ids.add(item.external_id);
        const extra = listedInfo(item);
        if (extra !== null) info.set(item.external_id, extra);
      }
    }

    const next = page.next_cursor;
    if (next === null || next === undefined || next === '') {
      return { ids, info };
    }
    if (typeof next !== 'string') {
      throw malformed('文章列表的分页游标格式不正确');
    }
    if (seen.has(next)) {
      throw malformed('文章列表的分页游标重复，无法读完远端列表');
    }
    seen.add(next);
    cursor = next;
  }
}

function resultsById(response) {
  const byId = new Map();
  if (response !== null && typeof response === 'object' && Array.isArray(response.results)) {
    for (const result of response.results) {
      if (result !== null && typeof result === 'object' && typeof result.external_id === 'string') {
        byId.set(result.external_id, result);
      }
    }
  }
  return byId;
}

// The code shown for a post MomoBird did not take. It comes from outside, so
// only a short identifier that cannot be a key is passed on.
function rejectionCode(result) {
  if (result === undefined) return 'NO_RESULT';
  if (result.status !== 'rejected') return 'UNKNOWN_STATUS';
  const code = result.error_code;
  if (typeof code === 'string' && CODE_PATTERN.test(code) && code.indexOf('mbk_') === -1) return code;
  return 'REJECTED';
}

function isHttp(err, status) {
  return err instanceof ConnectError && err.kind === 'http' && err.status === status;
}

// The server answers 413 for the whole request when a batch body is over its
// size limit, which says nothing about which post is too big.
function isTooLarge(err) {
  return isHttp(err, 413);
}

// 402: the plan has expired. Pushing is refused from now on, but listing and
// taking posts down still work.
function isPlanRequired(err) {
  return isHttp(err, 402);
}

// Sends one batch of posts and returns { results, tooLarge, planRequired }:
// the per-post results by id, the ids that are too large to send, and whether
// the server refused with a 402 (then the posts of the batch without a result
// were not taken, and nothing more should be sent). A 413 on a batch of
// several posts is retried one post at a time, so a single huge post cannot
// block the others; a 413 on a single post marks just that post. Any other
// error propagates and is fatal.
async function sendBatch(client, local, batch) {
  const tooLarge = new Set();
  const payloads = batch.map((id) => local.get(id).payload);
  try {
    return { results: resultsById(await client.upsertPosts(payloads)), tooLarge, planRequired: false };
  } catch (err) {
    if (isPlanRequired(err)) return { results: new Map(), tooLarge, planRequired: true };
    if (!isTooLarge(err)) throw err;
    if (batch.length === 1) {
      tooLarge.add(batch[0]);
      return { results: new Map(), tooLarge, planRequired: false };
    }
  }

  const results = new Map();
  for (const id of batch) {
    try {
      const single = resultsById(await client.upsertPosts([local.get(id).payload]));
      for (const [key, value] of single) results.set(key, value);
    } catch (err) {
      if (isPlanRequired(err)) return { results, tooLarge, planRequired: true };
      if (!isTooLarge(err)) throw err;
      tooLarge.add(id);
    }
  }
  return { results, tooLarge, planRequired: false };
}

function silentLog() {
  const quiet = () => {};
  return { info: quiet, warn: quiet, error: quiet };
}

// Runs one sync. A ConnectError from any call is fatal and propagates before
// anything further is sent: no removals after a failed push, and the cache
// keeps only what it held before minus the posts this run set out to push, so
// the next build pushes those again.
//
// The exception is a 402 on a push: the plan has expired, and the server
// refuses every push from then on but still lists and deletes. Pushing stops,
// the posts not pushed are reported in `planRequired`, and the removals still
// go out (prune guard included), so a post that was deleted, hidden or
// encrypted does not stay in MomoBird's answers until the plan is renewed.
async function runSync(input) {
  const { client, local, cacheFile } = input;
  const prune = Boolean(input.prune);
  const dryRun = Boolean(input.dryRun);
  const log = input.log || silentLog();

  const report = {
    planned: { push: [], remove: [] },
    pushed: 0,
    unchanged: 0,
    rejected: [],
    planRequired: [],
    removed: 0,
    pruneSkipped: false,
    held: [],
    withheld: 0,
    // Title and url by id for the planned removals, when the listing had them.
    listed: new Map()
  };

  const remote = await listRemote(client);
  const remoteIds = remote.ids;
  const cache = readCache(cacheFile);
  const unreadable = input.unreadable || new Map();
  const plan = planSync({ local, remoteIds, cache, prune, unreadable });
  // holdRemovals: this run takes nothing down (the caller says why), so the
  // guard has nothing to guard either.
  if (input.holdRemovals) {
    for (const id of remoteIds) {
      if (!local.has(id) && !unreadable.has(id)) report.withheld += 1;
    }
    plan.remove = [];
    plan.pruneSkipped = false;
  }
  report.planned = { push: plan.push, remove: plan.remove };
  for (const id of plan.remove) {
    if (remote.info.has(id)) report.listed.set(id, remote.info.get(id));
  }
  report.pruneSkipped = plan.pruneSkipped;
  report.held = plan.held;

  for (const id of plan.held) {
    log.warn(
      PREFIX + 'Hexo 没能读取这篇文章，暂不下线：' + unreadable.get(id) +
        '。请检查它的 front-matter 写法（构建日志里 Hexo 会为它报 Process failed），改好后重新生成'
    );
  }

  if (plan.pruneSkipped) {
    let wouldRemove = 0;
    for (const id of remoteIds) {
      if (!local.has(id) && !unreadable.has(id)) wouldRemove += 1;
    }
    log.warn(
      PREFIX + '清理保护：本地 ' + local.size + ' 篇，MomoBird 上有 ' + remoteIds.size + ' 篇，其中 ' +
        wouldRemove + ' 篇本地已没有，已跳过全部下线。确认要下线后，请运行 hexo momobird sync --prune'
    );
  }

  if (dryRun) {
    log.info(PREFIX + '试运行：将推送 ' + plan.push.length + ' 篇，下线 ' + plan.remove.length + ' 篇，未发送任何改动');
    return report;
  }

  let cacheWarningShown = false;
  function saveCache(map) {
    try {
      writeCache(cacheFile, map);
    } catch (err) {
      // The cache only saves requests; the sync itself goes on.
      if (cacheWarningShown) return;
      cacheWarningShown = true;
      log.warn(
        PREFIX + '缓存写入失败（' + (err && err.message ? err.message : '未知错误') + '），同步照常进行；' +
          '如果一直失败，请检查 node_modules/.cache/hexo-momobird-ai 目录的权限'
      );
    }
  }

  // Before anything is sent, forget the posts about to be pushed. A push the
  // server stores but whose answer never arrives (a dropped connection, a
  // killed build) must not leave the old digest behind: should the post later
  // return to that version, the digest would match again and the version the
  // server holds would never be replaced.
  const planned = new Set(plan.push);
  const kept = {};
  let forgotten = false;
  for (const id of Object.keys(cache)) {
    if (planned.has(id)) forgotten = true;
    else kept[id] = cache[id];
  }
  if (forgotten) saveCache(kept);

  const accepted = new Map();
  for (let start = 0; start < plan.push.length; start += PUSH_BATCH_SIZE) {
    const batch = plan.push.slice(start, start + PUSH_BATCH_SIZE);
    const { results, tooLarge, planRequired } = await sendBatch(client, local, batch);

    let refusedInBatch = 0;
    for (const id of batch) {
      const post = local.get(id);
      const result = results.get(id);
      const status = result === undefined ? undefined : result.status;
      if (tooLarge.has(id)) {
        report.rejected.push({ externalId: id, source: post.source, code: 'PAYLOAD_TOO_LARGE' });
        refusedInBatch += 1;
      } else if (status === 'created' || status === 'updated') {
        report.pushed += 1;
        accepted.set(id, post.digest);
      } else if (status === 'unchanged') {
        report.unchanged += 1;
        accepted.set(id, post.digest);
      } else if (planRequired) {
        report.planRequired.push(id);
      } else {
        report.rejected.push({ externalId: id, source: post.source, code: rejectionCode(result) });
        refusedInBatch += 1;
      }
    }

    if (planRequired) {
      // Every later batch would be refused the same way.
      for (const id of plan.push.slice(start + batch.length)) report.planRequired.push(id);
      log.info(PREFIX + '套餐已到期，停止推送，接着下线本地已没有的文章');
      break;
    }

    let line = PREFIX + '已推送 ' + (start + batch.length) + '/' + plan.push.length + ' 篇';
    if (refusedInBatch > 0) line += '，其中 ' + refusedInBatch + ' 篇被拒绝';
    log.info(line);
  }

  const gone = new Set();
  for (let start = 0; start < plan.remove.length; start += DELETE_BATCH_SIZE) {
    const batch = plan.remove.slice(start, start + DELETE_BATCH_SIZE);
    const results = resultsById(await client.deletePosts(batch));

    for (const id of batch) {
      const result = results.get(id);
      const status = result === undefined ? undefined : result.status;
      if (status === 'deleted') {
        report.removed += 1;
        gone.add(id);
      } else if (status === 'not_found') {
        gone.add(id);
      }
    }
    log.info(PREFIX + '已下线 ' + (start + batch.length) + '/' + plan.remove.length + ' 篇');
  }

  // What MomoBird is now known to hold: earlier records of posts that are
  // still there (local, or kept on the remote by the prune guard), except the
  // posts this run tried to push (only an accepted push may record them) and
  // those just taken down, then the digests it just accepted.
  const next = {};
  for (const id of Object.keys(kept)) {
    if (gone.has(id)) continue;
    if (local.has(id) || remoteIds.has(id)) next[id] = kept[id];
  }
  for (const [id, digest] of accepted) {
    next[id] = digest;
  }
  saveCache(next);

  return report;
}

module.exports = { planSync, runSync };
