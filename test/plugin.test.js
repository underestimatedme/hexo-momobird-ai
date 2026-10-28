'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { register } = require('../lib/plugin');
const { ConnectError } = require('../lib/client');
const { cachePath } = require('../lib/cache');
const { externalId } = require('../lib/post-id');

const KEY = 'mbk_live_0123456789abcdefSECRET';
const SOURCE_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NOW = new Date('2026-10-28T12:00:00.000Z');
const DEFAULT_API = 'https://api.valley.atlaspaces.com';

const WIDGET_SNIPPET =
  '<script defer src="https://momobird.atlaspaces.com/widget/loader.v1.js" data-project="pub_1"></script>';
const PODCAST_SCRIPT = '<script defer src="https://momobird.atlaspaces.com/widget/podcast.v1.js"></script>';
const NO_KEY_NOTICE = '[MomoBird] 未设置 MOMOBIRD_KEY，跳过同步';

const dirs = [];

test.after(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexo-momobird-plugin-'));
  dirs.push(dir);
  return dir;
}

function makePost(name, overrides) {
  return Object.assign(
    {
      _id: 'id-' + name,
      title: 'Post ' + name,
      slug: name,
      source: '_posts/' + name + '.md',
      published: true,
      content: '<p>Body of ' + name + '.</p>',
      date: new Date('2026-10-01T08:00:00.000Z'),
      updated: new Date('2026-10-02T09:30:00.000Z'),
      permalink: 'https://blog.example.com/' + name + '/',
      categories: []
    },
    overrides
  );
}

function makeStatus(overrides) {
  const o = overrides || {};
  return {
    project: Object.assign({ id: 'p1', name: '博客知识库' }, o.project),
    source: Object.assign(
      {
        id: SOURCE_ID,
        name: '我的 Hexo 博客',
        kind: 'hexo',
        site_url: 'https://blog.example.com',
        document_count: 2,
        ready_document_count: 2
      },
      o.source
    ),
    entitlement: Object.assign(
      {
        status: 'trial',
        active: true,
        trial_started_at: '2026-10-28T00:00:00Z',
        trial_ends_at: '2026-11-04T00:00:00Z',
        pro_ends_at: null
      },
      o.entitlement
    ),
    widget: Object.assign({ public_id: 'pub_1', available: true, reason: 'ok' }, o.widget)
  };
}

// A connect client that records every call. `remote` is the list of external
// ids MomoBird already holds.
function fakeClient(opts) {
  const o = opts || {};
  const calls = [];
  const upserted = [];
  const deleted = [];
  return {
    calls,
    upserted,
    deleted,
    async status() {
      calls.push('status');
      if (o.statusError) throw o.statusError;
      return o.status || makeStatus();
    },
    async listPosts() {
      calls.push('list');
      return {
        // `listed` adds fields to some items (a server that also lists titles).
        items: (o.remote || []).map((id) =>
          Object.assign({ external_id: id, document_id: 'doc-' + id, updated_at: 'x' }, o.listed && o.listed[id])
        ),
        next_cursor: null
      };
    },
    async upsertPosts(posts) {
      calls.push('upsert');
      if (o.upsertError) throw o.upsertError;
      for (const post of posts) upserted.push(post);
      return {
        results: posts.map((post) => ({
          external_id: post.external_id,
          status: o.upsertStatus ? o.upsertStatus(post) : 'created'
        }))
      };
    },
    async deletePosts(ids) {
      calls.push('delete');
      for (const id of ids) deleted.push(id);
      return { results: ids.map((id) => ({ external_id: id, status: 'deleted' })) };
    },
    async enableWidget() {
      calls.push('enable');
      if (o.enableError) throw o.enableError;
      return { enabled: true };
    }
  };
}

// The pieces of Hexo the plugin touches.
function makeHexo(opts) {
  const o = opts || {};
  const logs = [];
  const filters = {};
  const injected = [];
  const commands = {};
  const loads = [];
  const queries = [];
  const posts = o.posts || [makePost('a'), makePost('b')];
  const joinQueries = [];
  const joinsOf = (post) => (o.joins && o.joins[post._id]) || post.categories || [];
  const baseDir = o.baseDir || tmpDir();

  const hexo = {
    version: o.version || '8.1.2',
    env: { cmd: o.cmd === undefined ? 'g' : o.cmd, args: o.args || { _: ['g'] } },
    config: Object.assign({ url: 'https://blog.example.com', future: true, momobird: {} }, o.config),
    base_dir: baseDir,
    // Hexo's source_dir ends with a separator. The renderers of a plain site.
    source_dir: path.join(baseDir, 'source') + path.sep,
    render: { isRenderable: (file) => /\.(md|markdown|html?)$/i.test(file) },
    log: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      error: (message) => logs.push({ level: 'error', message })
    },
    extend: {
      filter: {
        register(type, fn) {
          (filters[type] = filters[type] || []).push(fn);
        }
      },
      injector: {
        register(entry, value, to) {
          injected.push({ entry, value, to });
        }
      },
      console: {
        alias: { g: 'generate', d: 'deploy', s: 'server' },
        register(name, desc, options, fn) {
          commands[name] = { name, desc, options, fn };
        }
      }
    },
    // Post, PostCategory and Category, as far as the plugin reads them.
    // post.categories is Hexo's site-wide order; the PostCategory rows of a
    // post come from `joins[post._id]` (front-matter order) when the test gives
    // them, else from post.categories.
    model(name) {
      if (name === 'Post') {
        return {
          find(query) {
            queries.push(query);
            return { toArray: () => posts.slice() };
          },
          // Every post Hexo read, in any state.
          toArray: () => posts.slice()
        };
      }
      if (name === 'PostCategory') {
        return {
          find(query) {
            joinQueries.push(query);
            const post = posts.find((candidate) => candidate._id === query.post_id);
            const docs = !post ? [] : joinsOf(post);
            return { toArray: () => docs.map((doc) => ({ post_id: post._id, category_id: doc._id })) };
          }
        };
      }
      if (name === 'Category') {
        return {
          findById(id) {
            for (const post of posts) {
              for (const doc of joinsOf(post).concat(post.categories || [])) {
                if (doc._id === id && !doc.missing) return doc;
              }
            }
            return undefined;
          }
        };
      }
      return assert.fail('the plugin asked for the unexpected model ' + name);
    },
    load() {
      loads.push(true);
      return Promise.resolve();
    }
  };
  return { hexo, logs, filters, injected, commands, loads, queries, joinQueries };
}

// Registers the plugin on a fake Hexo with a fake client, and returns helpers
// to run the registered filters and command the way Hexo would.
function setup(opts) {
  const o = opts || {};
  const parts = makeHexo(o);
  const client = fakeClient(o.client);
  const created = [];
  const exitCodes = [];
  const order = [];

  const deps = {
    createClient(options) {
      created.push(options);
      return client;
    },
    now: () => NOW,
    env: o.env === undefined ? { MOMOBIRD_KEY: KEY } : o.env,
    setExitCode: (code) => exitCodes.push(code)
  };
  register(parts.hexo, deps);

  async function run(type, data) {
    let value = data;
    for (const fn of parts.filters[type] || []) {
      const result = await fn(value);
      if (result !== undefined) value = result;
    }
    return value;
  }

  return Object.assign(parts, {
    client,
    created,
    exitCodes,
    order,
    run,
    // before_generate then after_generate, the way `hexo generate` calls them.
    async build() {
      await run('before_generate');
      await run('after_generate');
    },
    command: (args) => parts.commands.momobird.fn(args),
    text: () => parts.logs.map((entry) => entry.message).join('\n'),
    messages: (level) => parts.logs.filter((entry) => entry.level === level).map((entry) => entry.message)
  });
}

// Writes files under the site's source directory, as a blogger would.
function writeSource(t, files) {
  for (const file of files) {
    const full = path.join(t.hexo.source_dir, ...file.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '---\ntitle: x\n---\nbody\n');
  }
}

function momobird(extra) {
  return { momobird: Object.assign({}, extra) };
}

function postPage(name, overrides) {
  return Object.assign(makePost(name), { __post: true, layout: 'post' }, overrides);
}

// ---------------------------------------------------------------------------
// When it runs

test('server command does nothing', async () => {
  const t = setup({ cmd: 's', args: { _: ['s'] }, config: momobird({ widget: true, podcast: true }) });
  const locals = { page: postPage('a') };

  await t.run('before_generate');
  const after = await t.run('template_locals', locals);
  await t.run('after_generate');

  assert.equal(t.created.length, 0);
  assert.deepEqual(t.client.calls, []);
  assert.deepEqual(t.injected, []);
  assert.deepEqual(t.logs, []);
  assert.equal(after.page, locals.page);
  assert.equal(after.page.content, '<p>Body of a.</p>');
});

test('watch mode does nothing', async () => {
  const t = setup({ cmd: 'g', args: { _: ['g'], w: true }, config: momobird({ widget: true }) });

  await t.build();

  assert.equal(t.created.length, 0);
  assert.deepEqual(t.client.calls, []);
  assert.deepEqual(t.injected, []);
});

test('an upper-case command still counts as generate', async () => {
  const t = setup({ cmd: 'G', args: { _: ['G'] }, config: momobird({ widget: true, podcast: false }) });

  await t.build();

  assert.deepEqual(t.client.calls.slice(0, 1), ['status']);
  assert.equal(t.injected.length, 1);
});

test('deploy and its alias run the plugin too', async () => {
  for (const cmd of ['d', 'deploy', 'generate']) {
    const t = setup({ cmd, args: { _: [cmd] } });
    await t.build();
    assert.equal(t.client.upserted.length, 2, 'command ' + cmd);
  }
});

test('missing key logs once and does nothing', async () => {
  const t = setup({ cmd: 'g', env: {}, config: momobird({ widget: true, podcast: true }) });

  await t.run('before_generate');
  await t.run('before_generate');
  await t.run('template_locals', { page: postPage('a') });
  await t.run('after_generate');

  assert.deepEqual(t.logs, [{ level: 'info', message: NO_KEY_NOTICE }]);
  assert.equal(t.created.length, 0);
  assert.deepEqual(t.client.calls, []);
  assert.deepEqual(t.injected, []);
});

test('a blank key counts as missing', async () => {
  const t = setup({ env: { MOMOBIRD_KEY: '   ' } });

  await t.build();

  assert.deepEqual(t.messages('info'), [NO_KEY_NOTICE]);
  assert.equal(t.created.length, 0);
});

test('the client is created with the configured api and the key from the environment', async () => {
  const t = setup({ config: momobird({ api: 'http://localhost:8080' }) });

  await t.build();

  assert.deepEqual(t.created, [{ api: 'http://localhost:8080', key: KEY }]);
});

test('hexo older than 5 gets one line and nothing is registered', () => {
  for (const version of ['4.2.1', '3.9.0']) {
    const t = setup({ version, config: momobird({ widget: true }) });

    assert.equal(t.logs.length, 1);
    assert.match(t.logs[0].message, /^\[MomoBird\] .*需要 Hexo 5 或更高版本/);
    assert.deepEqual(t.filters, {});
    assert.deepEqual(t.commands, {});
    assert.deepEqual(t.injected, []);
  }
});

test('hexo 5 and later register the three filters and the command', () => {
  for (const version of ['5.0.0', '5.4.2', '6.3.0', '8.1.2']) {
    const t = setup({ version });

    assert.deepEqual(Object.keys(t.filters).sort(), ['after_generate', 'before_generate', 'template_locals']);
    assert.ok(t.commands.momobird, 'command on ' + version);
    assert.deepEqual(t.logs, []);
  }
});

test('the command is registered with a usage and the two flags', () => {
  const t = setup({});
  const command = t.commands.momobird;

  assert.equal(command.desc, 'MomoBird 同步工具');
  assert.equal(command.options.usage, '<status|sync>');
  assert.deepEqual(
    command.options.options.map((option) => option.name),
    ['--dry-run', '--prune']
  );
  assert.equal(typeof command.fn, 'function');
});

test('register works without any dependencies given', async () => {
  const parts = makeHexo({ cmd: 's', args: { _: ['s'] } });
  register(parts.hexo);

  for (const fn of parts.filters.before_generate) await fn();
  for (const fn of parts.filters.after_generate) await fn();

  assert.deepEqual(parts.logs, []);
  assert.deepEqual(parts.injected, []);
});

// ---------------------------------------------------------------------------
// Site address check

test('origin mismatch skips sync and frontend', async () => {
  const t = setup({
    config: Object.assign({ url: 'http://example.com' }, momobird({ widget: true, podcast: true })),
    client: { status: makeStatus({ source: { site_url: 'https://hexo.example.com' } }) }
  });

  await t.run('before_generate');
  const locals = await t.run('template_locals', { page: postPage('a') });
  await t.run('after_generate');

  const errors = t.messages('error');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].startsWith('[MomoBird] '));
  assert.ok(errors[0].includes('http://example.com'), errors[0]);
  assert.ok(errors[0].includes('https://hexo.example.com'), errors[0]);
  assert.deepEqual(t.injected, []);
  assert.equal(locals.page.content, '<p>Body of a.</p>');
  assert.deepEqual(t.client.calls, ['status']);
});

test('www and http/https differences are mismatches, path and case are not', async () => {
  const cases = [
    { url: 'https://www.blog.example.com', remote: 'https://blog.example.com', ok: false },
    { url: 'http://blog.example.com', remote: 'https://blog.example.com', ok: false },
    { url: 'https://blog.example.com:8443', remote: 'https://blog.example.com', ok: false },
    { url: 'https://blog.example.com/notes/', remote: 'https://blog.example.com', ok: true },
    { url: 'HTTPS://Blog.Example.COM', remote: 'https://blog.example.com/', ok: true },
    { url: 'https://blog.example.com:443', remote: 'https://blog.example.com', ok: true }
  ];
  for (const item of cases) {
    const t = setup({
      config: Object.assign({ url: item.url }, momobird({ widget: true })),
      client: { status: makeStatus({ source: { site_url: item.remote } }) }
    });
    await t.build();
    assert.equal(t.injected.length > 0, item.ok, item.url + ' vs ' + item.remote);
    assert.equal(t.client.upserted.length > 0, item.ok, item.url + ' vs ' + item.remote);
  }
});

test('an unparsable site url or source address is a mismatch that still prints both', async () => {
  for (const [url, remote] of [
    ['not a url', 'https://blog.example.com'],
    [undefined, 'https://blog.example.com'],
    ['https://blog.example.com', ''],
    ['https://blog.example.com', null]
  ]) {
    const t = setup({
      config: Object.assign({ url }, momobird({ widget: true })),
      client: { status: makeStatus({ source: { site_url: remote } }) }
    });
    await t.build();

    assert.equal(t.messages('error').length, 1);
    assert.deepEqual(t.injected, []);
    assert.equal(t.client.upserted.length, 0);
  }
});

test('strict turns an origin mismatch into a rejection without the key', async () => {
  const t = setup({
    config: Object.assign({ url: 'http://example.com' }, momobird({ strict: true })),
    client: { status: makeStatus({ source: { site_url: 'https://hexo.example.com' } }) }
  });

  await assert.rejects(t.run('before_generate'), (err) => {
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes('http://example.com'));
    assert.ok(err.message.includes('https://hexo.example.com'));
    assert.ok(!err.message.includes(KEY));
    return true;
  });
  await t.run('after_generate');
  assert.equal(t.client.upserted.length, 0);
});

test('a source of another kind is a warning and the run continues', async () => {
  const t = setup({
    config: momobird({ widget: true, podcast: false }),
    client: { status: makeStatus({ source: { kind: 'typecho' } }) }
  });

  await t.build();

  const warnings = t.messages('warn');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('typecho'));
  assert.equal(t.injected.length, 1);
  assert.equal(t.client.upserted.length, 2);
});

// The posts of a source of another kind were pushed by another platform; a
// Hexo site that does not have them is no reason to take them down.
function otherKindClient() {
  return {
    remote: [externalId('_posts/a.md'), '7770001', '7770002'],
    status: makeStatus({ source: { kind: 'wordpress' } })
  };
}

test('a source of another kind still gets the pushes, but nothing is taken down', async () => {
  const t = setup({ client: otherKindClient() });

  await t.build();

  assert.equal(t.client.upserted.length, 2);
  assert.ok(!t.client.calls.includes('delete'), t.client.calls.join(','));
  const warnings = t.messages('warn');
  assert.ok(warnings[0].includes('wordpress') && warnings[0].includes('不下线'), warnings[0]);
  const held = warnings.find((w) => w.includes('2 篇'));
  assert.ok(held && held.includes('hexo momobird sync --prune'), warnings.join('\n'));
  assert.ok(t.text().includes('下线 0 篇'), t.text());
});

test('hexo momobird sync on a source of another kind removes only with --prune', async () => {
  const plain = commandSetup({ client: otherKindClient() });
  await plain.command({ _: ['sync'] });
  assert.equal(plain.client.upserted.length, 2);
  assert.deepEqual(plain.client.deleted, []);
  assert.ok(plain.messages('warn').some((w) => w.includes('2 篇') && w.includes('--prune')), plain.text());
  assert.deepEqual(plain.exitCodes, []);

  const dry = commandSetup({ client: otherKindClient() });
  await dry.command({ _: ['sync'], 'dry-run': true });
  assert.ok(!dry.text().includes('将下线'), dry.text());
  assert.ok(dry.messages('warn').some((w) => w.includes('2 篇')), dry.text());

  const pruned = commandSetup({ client: otherKindClient() });
  await pruned.command({ _: ['sync'], prune: true });
  assert.deepEqual(pruned.client.deleted, ['7770001', '7770002']);
  assert.deepEqual(pruned.exitCodes, []);
});

test('a source id that is not a uuid stops sync and frontend before any path is built', async () => {
  for (const id of ['../../etc/passwd', '', 'not-a-uuid', 42, undefined]) {
    const t = setup({
      config: momobird({ widget: true, podcast: true }),
      client: { status: makeStatus({ source: { id } }) }
    });
    await t.build();
    await t.run('template_locals', { page: postPage('a') });

    assert.equal(t.messages('error').length, 1, String(id));
    assert.deepEqual(t.injected, []);
    assert.deepEqual(t.client.calls, ['status']);
    assert.ok(!fs.existsSync(path.join(t.hexo.base_dir, 'node_modules')));
  }
});

test('a status without a source object is refused the same way', async () => {
  const t = setup({ client: { status: { project: { id: 'p1' } } } });

  await t.build();

  assert.equal(t.messages('error').length, 1);
  assert.deepEqual(t.client.calls, ['status']);
});

// ---------------------------------------------------------------------------
// A normal build

test('a normal build injects the widget and the podcast script', async () => {
  const t = setup({ config: momobird({ widget: true, podcast: true }) });

  await t.run('before_generate');

  assert.deepEqual(t.injected, [
    { entry: 'body_end', value: WIDGET_SNIPPET, to: 'default' },
    { entry: 'body_end', value: PODCAST_SCRIPT, to: 'post' }
  ]);
  assert.deepEqual(t.client.calls, ['status']);
});

test('widget position left adds data-position', async () => {
  const t = setup({ config: momobird({ widget: true, widget_position: 'left', podcast: false }) });

  await t.run('before_generate');

  assert.deepEqual(t.injected, [
    {
      entry: 'body_end',
      value:
        '<script defer src="https://momobird.atlaspaces.com/widget/loader.v1.js" data-project="pub_1" data-position="left"></script>',
      to: 'default'
    }
  ]);
});

test('the widget is off by default and podcast can be turned off', async () => {
  const defaults = setup({});
  await defaults.run('before_generate');
  assert.deepEqual(defaults.injected, [{ entry: 'body_end', value: PODCAST_SCRIPT, to: 'post' }]);

  const none = setup({ config: momobird({ widget: false, podcast: false }) });
  await none.run('before_generate');
  assert.deepEqual(none.injected, []);
});

test('an unusable public id means no widget and a warning', async () => {
  const t = setup({
    config: momobird({ widget: true, podcast: false }),
    client: { status: makeStatus({ widget: { public_id: 'a"><script>' } }) }
  });

  await t.run('before_generate');

  assert.deepEqual(t.injected, []);
  assert.equal(t.messages('warn').length, 1);
});

test('running before_generate twice does not register the same markup twice', async () => {
  const t = setup({ config: momobird({ widget: true, podcast: true }) });

  await t.run('before_generate');
  await t.run('before_generate');

  assert.equal(t.injected.length, 2);
});

test('template_locals decorates only post pages that would be synced', async () => {
  const t = setup({ config: momobird({ podcast: true, podcast_transcript: true }) });
  await t.run('before_generate');

  const placeholder =
    '<div class="momobird-podcast" data-source="' + SOURCE_ID + '" data-post="' + externalId('_posts/a.md') +
    '" data-api="' + DEFAULT_API + '" data-transcript="1"></div>';

  const post = postPage('a');
  const decorated = await t.run('template_locals', { page: post });
  assert.equal(decorated.page.content, placeholder + '<p>Body of a.</p>');
  assert.equal(post.content, '<p>Body of a.</p>');
  assert.equal(decorated.page.title, 'Post a');

  const index = { page: { title: 'Home', content: '<p>Home</p>', posts: [] } };
  assert.equal((await t.run('template_locals', index)).page.content, '<p>Home</p>');

  const page = { page: Object.assign(makePost('about'), { layout: 'page' }) };
  assert.equal((await t.run('template_locals', page)).page.content, '<p>Body of about.</p>');

  for (const overrides of [{ hide: true }, { hidden: true }, { password: 'x' }, { momobird: false }, { published: false }]) {
    const skipped = await t.run('template_locals', { page: postPage('a', overrides) });
    assert.equal(skipped.page.content, '<p>Body of a.</p>', JSON.stringify(overrides));
  }

  const future = await t.run('template_locals', {
    page: postPage('a', { date: new Date('2026-12-01T00:00:00Z') })
  });
  assert.ok(future.page.content.startsWith('<div class="momobird-podcast"'), 'future: true keeps future posts');
});

test('template_locals respects a site that hides future posts', async () => {
  const t = setup({ config: Object.assign({ future: false }, momobird({ podcast: true })) });
  await t.run('before_generate');

  const future = await t.run('template_locals', {
    page: postPage('a', { date: new Date('2026-12-01T00:00:00Z') })
  });

  assert.equal(future.page.content, '<p>Body of a.</p>');
});

// Hexo hides scheduled posts with `!config.future`, so `future:` with nothing
// after it (null) and `future: 0` hide them just like `future: false`.
test('scheduled posts follow Hexo\'s truthiness of future: null and 0 hide them', async () => {
  for (const future of [null, 0, false, '']) {
    const later = makePost('later', { date: new Date('2026-12-01T00:00:00Z') });
    const t = setup({
      config: Object.assign({ future }, momobird({ podcast: true })),
      posts: [makePost('a'), later]
    });

    await t.build();
    const page = await t.run('template_locals', { page: postPage('later', { date: later.date }) });

    assert.deepEqual(
      t.client.upserted.map((post) => post.external_id),
      [externalId('_posts/a.md')],
      'future: ' + JSON.stringify(future)
    );
    assert.equal(page.page.content, '<p>Body of later.</p>', 'future: ' + JSON.stringify(future));
  }
});

test('template_locals leaves pages alone when podcast is off or the build is not running', async () => {
  const off = setup({ config: momobird({ podcast: false }) });
  await off.run('before_generate');
  assert.equal((await off.run('template_locals', { page: postPage('a') })).page.content, '<p>Body of a.</p>');

  const before = setup({ config: momobird({ podcast: true }) });
  assert.equal((await before.run('template_locals', { page: postPage('a') })).page.content, '<p>Body of a.</p>');
});

test('template_locals skips a post page without a source path', async () => {
  const t = setup({ config: momobird({ podcast: true }) });
  await t.run('before_generate');

  const result = await t.run('template_locals', { page: postPage('a', { source: undefined }) });

  assert.equal(result.page.content, '<p>Body of a.</p>');
});

test('after_generate syncs, prints the summary and enables a not-yet-published widget', async () => {
  const t = setup({
    config: momobird({ widget: true }),
    client: { status: makeStatus({ widget: { available: false, reason: 'not_published' } }) }
  });

  await t.build();

  assert.deepEqual(t.client.calls, ['status', 'list', 'upsert', 'enable']);
  assert.deepEqual(
    t.client.upserted.map((post) => post.external_id),
    [externalId('_posts/a.md'), externalId('_posts/b.md')]
  );
  assert.ok(t.messages('info').includes('[MomoBird] 同步完成：新增或更新 2 篇，未变 0 篇，下线 0 篇，失败 0 篇'));
  assert.deepEqual(t.messages('warn'), []);
  assert.deepEqual(t.messages('error'), []);
  assert.deepEqual(t.queries, [{ published: true }]);
  assert.ok(fs.existsSync(cachePath(t.hexo.base_dir, SOURCE_ID)), 'cache written under the base dir');
});

test('the widget is enabled only for not_published and only when widget is on', async () => {
  for (const [reason, widget, expected] of [
    ['not_published', true, 1],
    ['disabled_in_console', true, 0],
    ['plan_required', true, 0],
    ['origin_not_registered', true, 0],
    ['ok', true, 0],
    ['not_published', false, 0]
  ]) {
    const t = setup({
      config: momobird({ widget }),
      client: { status: makeStatus({ widget: { available: false, reason } }) }
    });
    await t.build();
    assert.equal(t.client.calls.filter((call) => call === 'enable').length, expected, reason + ' ' + widget);
  }
});

test('with sync off the widget is still enabled and nothing is pushed', async () => {
  const t = setup({
    config: momobird({ sync: false, widget: true }),
    client: { status: makeStatus({ widget: { available: false, reason: 'not_published' } }) }
  });

  await t.build();

  assert.deepEqual(t.client.calls, ['status', 'enable']);
  assert.ok(!t.text().includes('同步完成'));
});

test('a 409 when enabling the widget is a hint, not a failure', async () => {
  const t = setup({
    config: momobird({ widget: true, strict: true }),
    client: {
      status: makeStatus({ widget: { available: false, reason: 'not_published' } }),
      enableError: new ConnectError({ kind: 'http', status: 409, code: 'WIDGET_NOT_READY' })
    }
  });

  await t.build();

  assert.deepEqual(t.messages('warn'), []);
  assert.ok(t.messages('info').some((line) => line.includes('下次构建会自动再试')));
});

test('another error when enabling the widget is a failure', async () => {
  const lenient = setup({
    config: momobird({ widget: true }),
    client: {
      status: makeStatus({ widget: { available: false, reason: 'not_published' } }),
      enableError: new ConnectError({ kind: 'http', status: 503 })
    }
  });
  await lenient.build();
  assert.equal(lenient.messages('warn').length, 1);
  assert.ok(lenient.messages('warn')[0].includes('HTTP 503'));

  const strict = setup({
    config: momobird({ widget: true, strict: true }),
    client: {
      status: makeStatus({ widget: { available: false, reason: 'not_published' } }),
      enableError: new ConnectError({ kind: 'http', status: 503 })
    }
  });
  await strict.run('before_generate');
  await assert.rejects(strict.run('after_generate'), /HTTP 503/);
});

test('rejected posts get one line each and are counted', async () => {
  const t = setup({
    client: {
      upsertStatus: (post) => (post.external_id === externalId('_posts/b.md') ? 'rejected' : 'created')
    }
  });

  await t.build();

  assert.ok(t.messages('info').includes('[MomoBird] 同步完成：新增或更新 1 篇，未变 0 篇，下线 0 篇，失败 1 篇'));
  const warnings = t.messages('warn');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('_posts/b.md'));
  assert.ok(warnings[0].includes('REJECTED'));
});

test('strict also fails a build that had rejected posts', async () => {
  const t = setup({
    config: momobird({ strict: true }),
    client: { upsertStatus: () => 'rejected' }
  });

  await t.run('before_generate');
  await assert.rejects(t.run('after_generate'), (err) => {
    assert.ok(err.message.includes('2'));
    assert.ok(!err.message.includes(KEY));
    return true;
  });
});

test('a push failure rejects when strict and is one warning otherwise', async () => {
  const failure = new ConnectError({ kind: 'http', status: 500 });

  const strict = setup({
    config: momobird({ strict: true, widget: true }),
    client: { upsertError: failure, status: makeStatus({ widget: { available: false, reason: 'not_published' } }) }
  });
  await strict.run('before_generate');
  await assert.rejects(strict.run('after_generate'), (err) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, '[MomoBird] 同步失败：MomoBird 暂时不可用（HTTP 500）');
    assert.ok(!err.message.includes(KEY));
    return true;
  });

  const lenient = setup({
    config: momobird({ widget: true }),
    client: { upsertError: failure, status: makeStatus({ widget: { available: false, reason: 'not_published' } }) }
  });
  await lenient.build();
  assert.deepEqual(lenient.messages('warn'), ['[MomoBird] 同步失败：MomoBird 暂时不可用（HTTP 500）']);
  assert.deepEqual(lenient.messages('error'), []);
  assert.ok(!lenient.client.calls.includes('enable'), 'no widget enable after a fatal sync error');
  assert.ok(!lenient.text().includes('同步完成'));
});

// After the plan expires MomoBird refuses pushes (402) but still takes posts
// down, so a deleted or hidden post must not keep answering questions.
const PLAN_REQUIRED = new ConnectError({ kind: 'http', status: 402, code: 'PLAN_REQUIRED' });
const DELETED_ID = externalId('_posts/deleted.md');

function expiredClient() {
  return {
    remote: [externalId('_posts/a.md'), DELETED_ID],
    upsertError: PLAN_REQUIRED,
    status: makeStatus({ widget: { available: false, reason: 'not_published' } })
  };
}

test('a 402 on push still takes posts down and leaves a lenient build green, without enabling the widget', async () => {
  const t = setup({ config: momobird({ widget: true }), client: expiredClient() });

  await t.build();

  assert.deepEqual(t.client.calls, ['status', 'list', 'upsert', 'delete']);
  assert.deepEqual(t.client.deleted, [DELETED_ID]);
  const warnings = t.messages('warn');
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.ok(warnings[0].includes('套餐已到期'), warnings[0]);
  assert.ok(warnings[0].includes('新增或修改的 2 篇文章没有同步'), warnings[0]);
  assert.ok(warnings[0].includes('本次下线 1 篇'), warnings[0]);
  assert.ok(!t.text().includes('同步完成'), t.text());
  assert.ok(!t.text().includes('同步失败'), t.text());
  assert.deepEqual(t.messages('error'), []);
});

test('a 402 on push still takes posts down and fails a strict build', async () => {
  const t = setup({ config: momobird({ widget: true, strict: true }), client: expiredClient() });

  await t.run('before_generate');
  await assert.rejects(t.run('after_generate'), (err) => {
    assert.ok(err.message.includes('套餐已到期'), err.message);
    assert.ok(err.message.includes('本次下线 1 篇'), err.message);
    assert.ok(!err.message.includes(KEY));
    return true;
  });

  assert.deepEqual(t.client.deleted, [DELETED_ID]);
  assert.ok(!t.client.calls.includes('enable'));
});

test('a 402 on push leaves the cache without the posts that were not pushed', async () => {
  const t = setup({ client: expiredClient() });

  await t.build();

  const file = cachePath(t.hexo.base_dir, SOURCE_ID);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
});

test('hexo momobird sync after a 402 still takes posts down and exits non-zero', async () => {
  const t = commandSetup({ client: expiredClient() });

  await t.command({ _: ['sync'] });

  assert.deepEqual(t.client.deleted, [DELETED_ID]);
  assert.deepEqual(t.exitCodes, [1]);
  const errors = t.messages('error');
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.ok(errors[0].includes('套餐已到期') && errors[0].includes('本次下线 1 篇'), errors[0]);
});

test('a status failure skips the frontend and the sync, and rejects when strict', async () => {
  const failure = new ConnectError({ kind: 'http', status: 401 });

  const lenient = setup({ config: momobird({ widget: true, podcast: true }), client: { statusError: failure } });
  await lenient.build();
  await lenient.run('template_locals', { page: postPage('a') });
  assert.deepEqual(lenient.injected, []);
  assert.deepEqual(lenient.client.calls, ['status']);
  const warnings = lenient.messages('warn');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('连接密钥无效'));

  const strict = setup({ config: momobird({ strict: true }), client: { statusError: failure } });
  await assert.rejects(strict.run('before_generate'), /连接密钥无效/);
});

test('an unexpected error inside a filter never breaks a lenient build', async () => {
  const t = setup({});
  t.hexo.model = () => {
    throw new TypeError('boom');
  };

  await t.run('before_generate');
  await t.run('after_generate');

  assert.equal(t.messages('warn').length, 1);
  assert.ok(t.messages('warn')[0].includes('boom'));
});

test('duplicate ids stop the sync before anything is sent', async () => {
  const t = setup({
    config: momobird({ widget: true }),
    client: { status: makeStatus({ widget: { available: false, reason: 'not_published' } }) },
    posts: [makePost('a'), makePost('a-copy', { source: '_posts/a.md' })]
  });

  await t.build();

  const errors = t.messages('error');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('_posts/a.md'));
  assert.equal(t.client.upserted.length, 0);
  assert.ok(!t.client.calls.includes('upsert'));
  assert.ok(!t.client.calls.includes('list'));
  assert.ok(!t.client.calls.includes('delete'));
  assert.ok(!t.client.calls.includes('enable'));
  assert.ok(!t.text().includes('同步完成'));
});

test('duplicate ids reject when strict', async () => {
  const t = setup({
    config: momobird({ strict: true }),
    posts: [makePost('a'), makePost('a-copy', { source: '_posts/a.md' })]
  });

  await t.run('before_generate');
  await assert.rejects(t.run('after_generate'), /_posts\/a\.md/);
  assert.equal(t.client.upserted.length, 0);
});

test('the prune guard warning names the manual command', async () => {
  const remote = [];
  for (let i = 1; i <= 12; i += 1) remote.push('9000' + i);
  const t = setup({ client: { remote } });

  await t.build();

  const warnings = t.messages('warn');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('hexo momobird sync --prune'));
  assert.equal(t.client.deleted.length, 0);
});

// Hexo logs "Process failed" for a post whose front-matter it cannot parse and
// carries on without it, so the post is missing from the Post model. Taking it
// down would lose its podcast: it comes back later as a new document.
test('a post file Hexo could not read is not taken down, and the build log names it', async () => {
  const hidden = makePost('hidden', { hidden: true });
  const t = setup({
    posts: [makePost('a'), makePost('b'), hidden],
    client: {
      remote: [
        externalId('_posts/a.md'),
        externalId('_posts/b.md'),
        externalId('_posts/broken.md'),
        externalId('_posts/2026/nested-broken.md'),
        externalId('_posts/hidden.md'),
        externalId('_posts/deleted.md')
      ]
    }
  });
  writeSource(t, ['_posts/a.md', '_posts/b.md', '_posts/broken.md', '_posts/2026/nested-broken.md', '_posts/hidden.md']);

  await t.build();

  // The hidden post was read by Hexo, so it still comes down; so does the deleted one.
  assert.deepEqual(t.client.deleted, [externalId('_posts/hidden.md'), externalId('_posts/deleted.md')]);
  const warnings = t.messages('warn');
  assert.deepEqual(warnings.filter((w) => w.includes('Hexo 没能读取')).length, 2, warnings.join('\n'));
  assert.ok(warnings.some((w) => w.startsWith('[MomoBird] Hexo 没能读取这篇文章，暂不下线：_posts/broken.md')), warnings.join('\n'));
  assert.ok(warnings.some((w) => w.includes('：_posts/2026/nested-broken.md')), warnings.join('\n'));
  assert.ok(t.text().includes('下线 2 篇'), t.text());
});

test('hexo momobird sync keeps an unreadable post online too, even with --prune', async () => {
  const t = commandSetup({ client: { remote: [externalId('_posts/broken.md'), externalId('_posts/deleted.md')] } });
  writeSource(t, ['_posts/a.md', '_posts/b.md', '_posts/broken.md']);

  await t.command({ _: ['sync'], prune: true });

  assert.deepEqual(t.client.deleted, [externalId('_posts/deleted.md')]);
  assert.ok(t.messages('warn').some((w) => w.includes('暂不下线：_posts/broken.md')));
  assert.deepEqual(t.exitCodes, []);
});

// ---------------------------------------------------------------------------
// Configuration and the key

test('a key written in the config is refused and never printed', async () => {
  const SECRET = 'mbk_live_FROMCONFIGSECRET0123';
  for (const section of [{ key: SECRET }, { secret: SECRET }, { widget: SECRET }]) {
    const t = setup({ config: momobird(section) });

    await t.build();
    await t.run('template_locals', { page: postPage('a') });

    assert.equal(t.messages('error').length, 1);
    assert.ok(!t.text().includes('FROMCONFIGSECRET'));
    assert.ok(!t.text().includes(SECRET));
    assert.equal(t.created.length, 0);
    assert.deepEqual(t.injected, []);
  }
});

test('sync: off, no, 0 or "false" in _config.yml really switch the sync off', async () => {
  for (const value of ['off', 'no', 0, 'false']) {
    const t = setup({ config: momobird({ sync: value }) });

    await t.build();

    assert.deepEqual(t.client.calls, ['status'], JSON.stringify(value));
    assert.deepEqual(t.messages('warn'), [], JSON.stringify(value));
  }
});

test('momobird: false switches the plugin off: no request, no markup, no line in the log', async () => {
  for (const value of [false, 'no', 'off', 0]) {
    const t = setup({ config: { momobird: value } });

    await t.build();
    const locals = await t.run('template_locals', { page: postPage('a') });

    assert.equal(t.created.length, 0, JSON.stringify(value));
    assert.deepEqual(t.client.calls, [], JSON.stringify(value));
    assert.deepEqual(t.injected, [], JSON.stringify(value));
    assert.deepEqual(t.logs, [], JSON.stringify(value));
    assert.equal(locals.page.content, '<p>Body of a.</p>');
  }
});

test('an option value that is not understood is warned about once and the default applies', async () => {
  const t = setup({ config: momobird({ widget: 'maybe' }) });

  await t.build();
  assert.equal(t.client.upserted.length, 2, 'the rest of the config still works');
  await t.build();

  const warnings = t.messages('warn');
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.ok(warnings[0].startsWith('[MomoBird] '), warnings[0]);
  assert.ok(warnings[0].includes('momobird.widget') && warnings[0].includes('maybe'), warnings[0]);
  assert.ok(!t.injected.some((entry) => entry.to === 'default'), 'widget stays at its default, off');
});

test('strict: yes also makes a config error fail the build', async () => {
  const t = setup({ config: momobird({ strict: 'yes', key: 'x' }) });

  await assert.rejects(t.run('before_generate'), /MOMOBIRD_KEY/);
});

test('a config error rejects when strict, with the same text and no key', async () => {
  const SECRET = 'mbk_live_FROMCONFIGSECRET0123';
  const t = setup({ config: momobird({ key: SECRET, strict: true }) });

  await assert.rejects(t.run('before_generate'), (err) => {
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes('MOMOBIRD_KEY'));
    assert.ok(!err.message.includes('FROMCONFIGSECRET'));
    return true;
  });
  assert.equal(t.created.length, 0);
});

test('an invalid api address is reported and nothing is sent', async () => {
  const t = setup({ config: momobird({ api: 'http://api.example.com' }) });

  await t.build();

  assert.equal(t.messages('error').length, 1);
  assert.equal(t.created.length, 0);
});

test('no log line carries the key, even when an error message does', async () => {
  const leaky = new Error('socket hang up while sending ' + KEY + ' and mbk_live_other_secret_value');
  const t = setup({
    config: momobird({ widget: true, strict: false }),
    client: { upsertError: leaky, status: makeStatus({ widget: { available: false, reason: 'not_published' } }) }
  });

  await t.build();

  assert.ok(t.logs.length > 0);
  assert.ok(!t.text().includes(KEY));
  assert.ok(!t.text().includes('mbk_'));
  assert.ok(!t.text().includes('0123456789abcdef'));

  const strict = setup({
    config: momobird({ strict: true }),
    client: { upsertError: leaky }
  });
  await strict.run('before_generate');
  await assert.rejects(strict.run('after_generate'), (err) => {
    assert.ok(!err.message.includes(KEY));
    assert.ok(!err.message.includes('mbk_'));
    return true;
  });
});

test('a key that does not look like mbk_ is removed from messages too', async () => {
  const PLAIN = 'plainSecretValue9876';
  const leaky = new Error('refused: Bearer ' + PLAIN);
  const t = setup({
    env: { MOMOBIRD_KEY: PLAIN },
    client: { upsertError: leaky }
  });

  await t.build();

  assert.equal(t.messages('warn').length, 1);
  assert.ok(!t.text().includes(PLAIN));
  assert.ok(t.text().includes('***'));
});

test('across a normal build with every feature on, the logs never contain the key', async () => {
  const t = setup({
    config: momobird({ widget: true, podcast: true }),
    client: { status: makeStatus({ widget: { available: false, reason: 'not_published' } }) }
  });

  await t.build();
  await t.command({ _: ['status'] });
  await t.command({ _: ['sync'] });

  assert.ok(t.logs.length > 3);
  assert.ok(!t.text().includes(KEY));
  assert.ok(!t.text().includes('mbk_'));
  for (const entry of t.logs) {
    assert.ok(entry.message.startsWith('[MomoBird] '), entry.message);
  }
});

// ---------------------------------------------------------------------------
// hexo momobird

function commandSetup(opts) {
  const o = Object.assign({ cmd: 'momobird', args: { _: ['momobird', 'status'] } }, opts);
  return setup(o);
}

test('the command does not run the automatic hooks, so it loads and asks for the status itself', async () => {
  const t = commandSetup({ config: momobird({ widget: true, podcast: true }) });

  await t.run('before_generate');
  await t.run('after_generate');
  assert.deepEqual(t.client.calls, []);
  assert.deepEqual(t.injected, []);
  assert.deepEqual(t.logs, []);

  await t.command({ _: ['status'] });
  assert.equal(t.loads.length, 1);
  assert.deepEqual(t.client.calls, ['status']);
});

test('hexo momobird status prints the project, source, plan, widget, address check and counts', async () => {
  const t = commandSetup({});

  await t.command({ _: ['status'] });

  const text = t.text();
  assert.ok(text.includes('项目：博客知识库'), text);
  assert.ok(text.includes('来源：我的 Hexo 博客（类型 hexo）'), text);
  assert.ok(text.includes('套餐：试用中，2026-11-04 到期'), text);
  assert.ok(text.includes('问答助手：可用'), text);
  assert.ok(text.includes('站点地址：一致（https://blog.example.com）'), text);
  assert.ok(text.includes('文章：本地 2 篇，MomoBird 上 2 篇'), text);
  assert.deepEqual(t.exitCodes, []);
  assert.deepEqual(t.client.calls, ['status']);
  assert.deepEqual(t.messages('error'), []);
});

test('hexo momobird status describes the other plans and widget states', async () => {
  const cases = [
    [{ entitlement: { status: 'pro', pro_ends_at: '2027-01-15T00:00:00Z' } }, '套餐：专业版，2027-01-15 到期'],
    [{ entitlement: { status: 'expired', active: false } }, '套餐：已到期'],
    [{ widget: { available: false, reason: 'not_published' } }, '问答助手：还没上线'],
    [{ widget: { available: false, reason: 'disabled_in_console' } }, '问答助手：已在 MomoBird 控制台关闭'],
    [{ widget: { available: false, reason: 'plan_required' } }, '问答助手：套餐已到期']
  ];
  for (const [overrides, expected] of cases) {
    const t = commandSetup({ client: { status: makeStatus(overrides) } });
    await t.command({ _: ['status'] });
    assert.ok(t.text().includes(expected), expected + '\n' + t.text());
  }
});

test('hexo momobird status mentions posts that are still being indexed', async () => {
  const t = commandSetup({ client: { status: makeStatus({ source: { document_count: 5, ready_document_count: 3 } }) } });

  await t.command({ _: ['status'] });

  assert.ok(t.messages('info').includes('[MomoBird] 文章：本地 2 篇，MomoBird 上 5 篇（其中 3 篇已建好索引）'), t.text());
});

test('hexo momobird status warns about a source of another kind but works', async () => {
  const t = commandSetup({ client: { status: makeStatus({ source: { kind: 'wordpress' } }) } });

  await t.command({ _: ['status'] });

  assert.equal(t.messages('warn').length, 1);
  assert.ok(t.messages('warn')[0].includes('wordpress'));
  assert.ok(t.messages('warn')[0].includes('除非加 --prune'), t.messages('warn')[0]);
  assert.deepEqual(t.exitCodes, []);
});

test('hexo momobird status with an address mismatch prints both addresses and exits non-zero', async () => {
  const t = commandSetup({
    config: { url: 'http://example.com' },
    client: { status: makeStatus({ source: { site_url: 'https://hexo.example.com' } }) }
  });

  await t.command({ _: ['status'] });

  assert.ok(t.text().includes('站点地址：不一致'));
  const errors = t.messages('error');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('http://example.com') && errors[0].includes('https://hexo.example.com'));
  assert.deepEqual(t.exitCodes, [1]);
});

test('hexo momobird sync pushes the posts and prints the summary', async () => {
  const t = commandSetup({ args: { _: ['momobird', 'sync'] } });

  await t.command({ _: ['sync'] });

  assert.equal(t.client.upserted.length, 2);
  assert.ok(t.messages('info').includes('[MomoBird] 同步完成：新增或更新 2 篇，未变 0 篇，下线 0 篇，失败 0 篇'));
  assert.deepEqual(t.exitCodes, []);
  assert.ok(fs.existsSync(cachePath(t.hexo.base_dir, SOURCE_ID)));
});

test('hexo momobird sync runs even when sync is switched off in the config', async () => {
  const t = commandSetup({ config: momobird({ sync: false }) });

  await t.command({ _: ['sync'] });

  assert.equal(t.client.upserted.length, 2);
});

test('hexo momobird sync --dry-run lists the plan and sends nothing', async () => {
  const t = commandSetup({ client: { remote: ['777'] } });

  await t.command({ _: ['sync'], 'dry-run': true });

  assert.deepEqual(t.client.upserted, []);
  assert.deepEqual(t.client.deleted, []);
  assert.ok(!t.client.calls.includes('upsert'));
  assert.ok(!t.client.calls.includes('delete'));
  const text = t.text();
  assert.ok(text.includes('试运行'), text);
  assert.ok(text.includes('_posts/a.md'), text);
  assert.ok(text.includes('_posts/b.md'), text);
  assert.ok(text.includes('777'), text);
  assert.ok(!text.includes('同步完成'));
  assert.deepEqual(t.exitCodes, []);
  assert.ok(!fs.existsSync(cachePath(t.hexo.base_dir, SOURCE_ID)));
});

test('hexo momobird sync --dry-run names each post it would take down and why', async () => {
  const kept = [
    makePost('hidden', { hidden: true }),
    makePost('unpublished', { published: false }),
    makePost('locked', { password: 'secret' }),
    makePost('optout', { momobird: false }),
    makePost('later', { date: new Date('2026-12-01T00:00:00Z') }),
    makePost('empty', { content: '' })
  ];
  const t = commandSetup({
    config: Object.assign({ future: false }, momobird({})),
    posts: [makePost('a'), makePost('b')].concat(kept),
    client: {
      remote: kept.map((post) => externalId(post.source)).concat(['5550001', '5550002', '5550003']),
      listed: {
        5550001: { title: '旧文章', url: 'https://blog.example.com/old/' },
        5550002: { title: '没有链接的旧文章' }
      }
    }
  });

  await t.command({ _: ['sync'], 'dry-run': true });

  const removals = t.messages('info').filter((line) => line.includes('将下线：'));
  assert.deepEqual(removals, [
    '[MomoBird] 将下线：_posts/hidden.md（隐藏）',
    '[MomoBird] 将下线：_posts/unpublished.md（未发布）',
    '[MomoBird] 将下线：_posts/locked.md（加密）',
    '[MomoBird] 将下线：_posts/optout.md（momobird: false）',
    '[MomoBird] 将下线：_posts/later.md（未到发布时间）',
    '[MomoBird] 将下线：_posts/empty.md（正文为空）',
    '[MomoBird] 将下线：旧文章（https://blog.example.com/old/）',
    '[MomoBird] 将下线：没有链接的旧文章',
    '[MomoBird] 将下线：编号 5550003（本地找不到对应文件）'
  ]);
  assert.ok(!t.client.calls.includes('delete'));
});

test('hexo momobird sync --prune passes the flag through, and without it the guard holds', async () => {
  const remote = [];
  for (let i = 1; i <= 12; i += 1) remote.push('9000' + i);

  const guarded = commandSetup({ client: { remote } });
  await guarded.command({ _: ['sync'] });
  assert.equal(guarded.client.deleted.length, 0);
  assert.ok(guarded.text().includes('hexo momobird sync --prune'));

  const pruned = commandSetup({ client: { remote } });
  await pruned.command({ _: ['sync'], prune: true });
  assert.equal(pruned.client.deleted.length, 12);
  assert.ok(pruned.text().includes('下线 12 篇'));
  assert.deepEqual(pruned.exitCodes, []);
});

function twelveRemoteIds() {
  const remote = [];
  for (let i = 1; i <= 12; i += 1) remote.push('9000' + i);
  return remote;
}

// hexo-cli parses the command line with minimist: `--prune` is true,
// `--prune=` is '', `--prune true` is 'true', `--prune=no` and `--prune no`
// are 'no', `--prune=0` is 0 and `--no-prune` is false. Only the first three
// switch a flag on; anything else is a usage error, so a typed "no" can never
// mean "remove without the guard", nor silently mean nothing.
test('hexo momobird sync accepts --prune and --dry-run only as true, "" or "true"', async () => {
  for (const value of [true, '', 'true']) {
    const pruned = commandSetup({ client: { remote: twelveRemoteIds() } });
    await pruned.command({ _: ['sync'], prune: value });
    assert.equal(pruned.client.deleted.length, 12, 'prune ' + JSON.stringify(value));
    assert.deepEqual(pruned.exitCodes, [], 'prune ' + JSON.stringify(value));

    for (const name of ['dry-run', 'dry_run', 'dryRun']) {
      const dry = commandSetup({ client: { remote: ['90001'] } });
      await dry.command({ _: ['sync'], [name]: value });
      assert.deepEqual(dry.client.calls, ['status', 'list'], name + ' ' + JSON.stringify(value));
      assert.deepEqual(dry.exitCodes, [], name + ' ' + JSON.stringify(value));
    }
  }
});

test('any other --prune or --dry-run value is a usage error: exit 1, nothing loaded or sent', async () => {
  const spellings = [];
  for (const value of ['no', 'off', 'false', 'NO', false, 0, '0', 'yes', 1, 'maybe', null, [true, true]]) {
    spellings.push({ prune: value });
    spellings.push({ 'dry-run': value });
  }
  spellings.push({ dry_run: 'false' }, { dryRun: 'no' }, { 'dry-run': true, prune: 'no' }, { 'dry-run': 'no', prune: true });

  for (const flags of spellings) {
    const label = JSON.stringify(flags);
    const t = commandSetup({ client: { remote: twelveRemoteIds() } });

    await t.command(Object.assign({ _: ['sync'] }, flags));

    assert.deepEqual(t.exitCodes, [1], label);
    assert.equal(t.loads.length, 0, label);
    assert.deepEqual(t.client.calls, [], label);
    const errors = t.messages('error');
    assert.equal(errors.length, 1, label);
    assert.ok(errors[0].includes('用法：hexo momobird <status|sync> [--dry-run] [--prune]'), errors[0]);
    assert.ok(errors[0].includes(Object.prototype.hasOwnProperty.call(flags, 'prune') && flags.prune !== true ? '--prune' : '--dry-run'), errors[0]);
  }
});

test('hexo momobird sync exits non-zero on a fatal sync error', async () => {
  const t = commandSetup({ client: { upsertError: new ConnectError({ kind: 'http', status: 500 }) } });

  await t.command({ _: ['sync'] });

  const errors = t.messages('error');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('HTTP 500'));
  assert.ok(!t.text().includes('同步完成'));
  assert.deepEqual(t.exitCodes, [1]);
});

test('hexo momobird sync exits non-zero when posts were rejected', async () => {
  const t = commandSetup({ client: { upsertStatus: () => 'rejected' } });

  await t.command({ _: ['sync'] });

  assert.ok(t.text().includes('失败 2 篇'));
  assert.deepEqual(t.exitCodes, [1]);
});

test('hexo momobird sync refuses duplicate ids and exits non-zero', async () => {
  const t = commandSetup({ posts: [makePost('a'), makePost('a-copy', { source: '_posts/a.md' })] });

  await t.command({ _: ['sync'] });

  assert.equal(t.messages('error').length, 1);
  assert.deepEqual(t.client.upserted, []);
  assert.ok(!t.client.calls.includes('list'));
  assert.deepEqual(t.exitCodes, [1]);
});

test('hexo momobird sync with an address mismatch does not sync and exits non-zero', async () => {
  const t = commandSetup({
    config: { url: 'http://example.com' },
    client: { status: makeStatus({ source: { site_url: 'https://hexo.example.com' } }) }
  });

  await t.command({ _: ['sync'] });

  assert.deepEqual(t.client.calls, ['status']);
  const errors = t.messages('error');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('http://example.com') && errors[0].includes('https://hexo.example.com'));
  assert.deepEqual(t.exitCodes, [1]);
});

test('the command without a key says why and exits non-zero', async () => {
  for (const sub of ['status', 'sync']) {
    const t = commandSetup({ env: {} });

    await t.command({ _: [sub] });

    const errors = t.messages('error');
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('MOMOBIRD_KEY'));
    assert.deepEqual(t.client.calls, []);
    assert.equal(t.created.length, 0);
    assert.deepEqual(t.exitCodes, [1]);
  }
});

test('the command with a bad config says why and exits non-zero', async () => {
  const t = commandSetup({ config: momobird({ key: 'mbk_live_FROMCONFIGSECRET0123' }) });

  await t.command({ _: ['sync'] });

  assert.equal(t.messages('error').length, 1);
  assert.ok(!t.text().includes('FROMCONFIGSECRET'));
  assert.equal(t.created.length, 0);
  assert.deepEqual(t.exitCodes, [1]);
});

test('the command exits non-zero when the status cannot be read', async () => {
  const t = commandSetup({ client: { statusError: new ConnectError({ kind: 'http', status: 401 }) } });

  await t.command({ _: ['status'] });

  const errors = t.messages('error');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('连接密钥无效'));
  assert.deepEqual(t.exitCodes, [1]);
});

test('the command refuses a source id that is not a uuid', async () => {
  const t = commandSetup({ client: { status: makeStatus({ source: { id: '../x' } }) } });

  await t.command({ _: ['sync'] });

  assert.equal(t.messages('error').length, 1);
  assert.deepEqual(t.client.calls, ['status']);
  assert.deepEqual(t.exitCodes, [1]);
});

test('an unknown subcommand prints the usage and exits non-zero without loading the site', async () => {
  for (const args of [{ _: [] }, { _: ['push'] }, {}]) {
    const t = commandSetup({});

    await t.command(args);

    assert.equal(t.loads.length, 0);
    assert.deepEqual(t.client.calls, []);
    assert.equal(t.messages('error').length, 1);
    assert.ok(t.messages('error')[0].includes('hexo momobird <status|sync>'));
    assert.deepEqual(t.exitCodes, [1]);
  }
});

test('the site is loaded before the first request', async () => {
  const events = [];
  const t = commandSetup({});
  t.hexo.load = () => {
    events.push('load');
    return Promise.resolve();
  };
  const originalStatus = t.client.status;
  t.client.status = () => {
    events.push('status');
    return originalStatus();
  };

  await t.command({ _: ['status'] });

  assert.deepEqual(events, ['load', 'status']);
});

test('by default a failing command sets process.exitCode to 1', async () => {
  const parts = makeHexo({ cmd: 'momobird', args: { _: ['momobird', 'sync'] } });
  register(parts.hexo, { env: {}, createClient: () => assert.fail('no client without a key') });
  const before = process.exitCode;

  try {
    process.exitCode = undefined;
    await parts.commands.momobird.fn({ _: ['sync'] });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = before;
  }
});

// ---------------------------------------------------------------------------
// Category order

// post.categories comes back in the order the categories were created on the
// site, which is neither the post's front-matter order nor stable between
// builds. The post's own PostCategory rows keep the front-matter order.
function multiRootPost() {
  const tech = { _id: 'c-tech', name: '技术' };
  const zeta = { _id: 'c-zeta', name: 'Zeta' };
  const inner = { _id: 'c-inner', name: 'Inner', parent: 'c-zeta' };
  const alpha = { _id: 'c-alpha', name: 'Alpha' };
  return {
    post: makePost('multi', { categories: [tech, zeta, inner, alpha] }),
    frontMatter: [zeta, inner, alpha, tech]
  };
}

test('a build sends the first top-level category in front-matter order, read from the PostCategory rows', async () => {
  const { post, frontMatter } = multiRootPost();
  const t = setup({ posts: [post], joins: { [post._id]: frontMatter } });

  await t.build();

  assert.equal(t.client.upserted.length, 1);
  assert.equal(t.client.upserted[0].category, 'Zeta');
  assert.deepEqual(t.joinQueries, [{ post_id: post._id }]);
});

test('the category does not change when only the site-wide order of post.categories changes', async () => {
  const { post, frontMatter } = multiRootPost();
  const reordered = Object.assign({}, post, { categories: post.categories.slice().reverse() });

  const first = setup({ posts: [post], joins: { [post._id]: frontMatter } });
  const second = setup({ posts: [reordered], joins: { [post._id]: frontMatter } });
  await first.build();
  await second.build();

  assert.equal(first.client.upserted[0].category, 'Zeta');
  assert.deepEqual(second.client.upserted, first.client.upserted);
});

test('hexo momobird sync sends the PostCategory order too', async () => {
  const { post, frontMatter } = multiRootPost();
  const t = setup({
    cmd: 'momobird',
    args: { _: ['momobird', 'sync'] },
    posts: [post],
    joins: { [post._id]: frontMatter }
  });

  await t.command({ _: ['sync'] });

  assert.equal(t.client.upserted.length, 1);
  assert.equal(t.client.upserted[0].category, 'Zeta');
  assert.deepEqual(t.exitCodes, []);
});

test('a post whose PostCategory rows are empty is sent without a category', async () => {
  const { post } = multiRootPost();
  const t = setup({ posts: [post], joins: { [post._id]: [] } });

  await t.build();

  assert.equal(t.client.upserted.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(t.client.upserted[0], 'category'), false);
});

test('a PostCategory row whose category no longer exists is skipped', async () => {
  const { post, frontMatter } = multiRootPost();
  const ghost = { _id: 'c-ghost', name: 'Ghost', missing: true };
  const t = setup({ posts: [post], joins: { [post._id]: [ghost].concat(frontMatter) } });

  await t.build();

  assert.equal(t.client.upserted[0].category, 'Zeta');
});

// ---------------------------------------------------------------------------
// The package entry

test('index.js registers the plugin on the global hexo', () => {
  const parts = makeHexo({ cmd: 's', args: { _: ['s'] } });
  const entry = require.resolve('../index.js');

  global.hexo = parts.hexo;
  delete require.cache[entry];
  try {
    require('../index.js');
  } finally {
    delete global.hexo;
    delete require.cache[entry];
  }

  assert.deepEqual(Object.keys(parts.filters).sort(), ['after_generate', 'before_generate', 'template_locals']);
  assert.ok(parts.commands.momobird);
  assert.equal(global.hexo, undefined);
});
