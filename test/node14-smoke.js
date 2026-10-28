'use strict';

// Loads every module and runs a sync against the local mock, using nothing but
// `assert`, so it also runs on Node 14 (where node:test does not exist):
//
//   docker run --rm -v "$PWD":/p -w /p node:14 node test/node14-smoke.js
//
// `node --test` picks this file up as well and runs it on the current Node.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const postId = require('../lib/post-id');
const content = require('../lib/content');
const config = require('../lib/config');
const command = require('../lib/command');
const posts = require('../lib/posts');
const client = require('../lib/client');
const cache = require('../lib/cache');
const reconcile = require('../lib/reconcile');
const frontend = require('../lib/frontend');
const plugin = require('../lib/plugin');
const mock = require('../dev/mock-connect');

const KEY = mock.KEY;
const SITE_URL = 'https://hexo.example.com';

function removeDir(dir) {
  if (fs.rmSync) fs.rmSync(dir, { recursive: true, force: true });
  else fs.rmdirSync(dir, { recursive: true });
}

function step(name) {
  process.stdout.write('ok   ' + name + '\n');
}

function fakePost(source, title, html, categories) {
  return {
    published: true,
    source,
    title,
    slug: source,
    content: html,
    permalink: SITE_URL + '/' + source.replace(/^_posts\//, '').replace(/\.md$/, '') + '/',
    categories: categories || [],
    date: new Date('2026-10-20T01:30:00.000Z'),
    updated: new Date('2026-10-21T02:00:00.000Z')
  };
}

function loadsEverything() {
  const modules = { postId, content, config, command, posts, client, cache, reconcile, frontend, plugin };
  Object.keys(modules).forEach((name) => {
    assert.strictEqual(typeof modules[name], 'object', name);
    assert.ok(Object.keys(modules[name]).length > 0, name + ' exports nothing');
  });
  step('every lib/ module loads on ' + process.version);
}

function fixedValues() {
  assert.strictEqual(postId.externalId('_posts/hello-world.md'), '2771473582013371');
  assert.strictEqual(postId.externalId('_posts/中文 文章.md'), '3673941822749037');
  assert.strictEqual(postId.externalId('_posts\\a\\b.md'), postId.externalId('_posts/a/b.md'));
  assert.ok(/^[0-9]{1,16}$/.test(postId.externalId('_posts/x.md')));
  step('externalId');

  assert.strictEqual(content.documentText('T', '<p>你好</p>'), '# T\n\n你好');
  assert.strictEqual(content.documentText('T', '<h2>小节</h2><p>正文</p>'), '# T\n\n## 小节\n\n正文');
  assert.strictEqual(content.plainText('<b>a &amp; b</b>'), 'a & b');
  step('documentText');

  const local = new Map([
    ['1', { digest: 'd1' }],
    ['2', { digest: 'd2' }],
    ['3', { digest: 'd3' }]
  ]);
  const plan = reconcile.planSync({
    local,
    remoteIds: new Set(['2', '3', '9']),
    cache: { 2: 'd2', 3: 'old' },
    prune: false
  });
  assert.deepStrictEqual(plan, { push: ['1', '3'], remove: ['9'], pruneSkipped: false, held: [] });
  const empty = reconcile.planSync({ local: new Map(), remoteIds: new Set(['9']), cache: {}, prune: false });
  assert.deepStrictEqual(empty, { push: [], remove: [], pruneSkipped: true, held: [] });
  const pruned = reconcile.planSync({ local: new Map(), remoteIds: new Set(['9']), cache: {}, prune: true });
  assert.deepStrictEqual(pruned, { push: [], remove: ['9'], pruneSkipped: false, held: [] });
  step('planSync');

  assert.strictEqual(
    frontend.widgetSnippet('pub_x', 'left'),
    '<script defer src="https://momobird.atlaspaces.com/widget/loader.v1.js" data-project="pub_x" data-position="left"></script>'
  );
  assert.strictEqual(frontend.widgetSnippet('bad id', 'right'), '');
  assert.ok(frontend.podcastPlaceholder({ sourceId: mock.SOURCE_ID, externalId: '1', api: 'http://x/' }).indexOf('data-api="http://x"') > 0);
  assert.throws(() => config.readConfig({ momobird: { key: 'mbk_x' } }, {}), config.ConfigError);
  assert.strictEqual(config.readConfig({}, {}).key, null);
  assert.ok(command.autoRunEnabled({ cmd: 'generate', args: {}, aliases: {} }));
  assert.ok(!command.autoRunEnabled({ cmd: 'generate', args: { w: true }, aliases: {} }));
  step('config, command, frontend');

  const withHook = posts.mapPost(fakePost('_posts/c.md', 'C', '<p>x</p>', [{ name: '技术' }]), {
    categoriesOf: () => [{ name: 'Zeta' }, { name: 'Inner', parent: 'z' }, { name: '技术' }]
  });
  assert.strictEqual(withHook.payload.category, 'Zeta');
  step('mapPost with categoriesOf');
}

function registersIntoHexo() {
  const seen = { filters: [], commands: [] };
  global.hexo = {
    version: '5.4.2',
    config: {},
    env: {},
    log: { info() {}, warn() {}, error() {} },
    extend: {
      filter: { register: (name) => seen.filters.push(name) },
      console: { register: (name) => seen.commands.push(name), alias: {} }
    }
  };
  try {
    require('../index.js');
  } finally {
    delete global.hexo;
  }
  assert.deepStrictEqual(seen.filters.sort(), ['after_generate', 'before_generate', 'template_locals']);
  assert.deepStrictEqual(seen.commands, ['momobird']);
  step('index.js registers three filters and the momobird command');
}

async function syncsAgainstTheMock() {
  const server = await mock.startMock({ siteUrl: SITE_URL });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexo-momobird-smoke-'));
  try {
    const api = client.createClient({ api: server.url, key: KEY, retryDelaysMs: [] });
    const status = await api.status();
    assert.strictEqual(status.source.kind, 'hexo');
    assert.strictEqual(status.source.site_url, SITE_URL);

    const list = [
      fakePost('_posts/one.md', '第一篇', '<p>你好 Node 14</p>'),
      fakePost('_posts/two.md', '第二篇', '<h2>小节</h2><p>正文</p>', [{ name: '技术', parent: null }])
    ];
    const collected = posts.collectLocal(list, { future: true, now: new Date('2026-11-01T00:00:00Z') });
    assert.strictEqual(collected.items.size, 2);
    assert.strictEqual(collected.duplicates.length, 0);

    const cacheFile = cache.cachePath(dir, status.source.id);
    const lines = [];
    const log = { info: (t) => lines.push(t), warn: (t) => lines.push(t), error: (t) => lines.push(t) };
    const run = (local, extra) =>
      reconcile.runSync(Object.assign({ client: api, local, cacheFile, prune: false, dryRun: false, log }, extra));

    const dry = await run(collected.items, { dryRun: true });
    assert.strictEqual(dry.planned.push.length, 2);
    assert.strictEqual(server.requests.filter((r) => r.method === 'PUT').length, 0);

    const first = await run(collected.items);
    assert.strictEqual(first.pushed, 2);
    assert.strictEqual(first.removed, 0);
    assert.strictEqual(first.rejected.length, 0);
    assert.strictEqual(server.state.posts.size, 2);
    assert.strictEqual(server.requests.filter((r) => r.method === 'PUT').length, 1);

    const second = await run(collected.items);
    assert.strictEqual(second.pushed + second.unchanged, 0);
    assert.strictEqual(server.requests.filter((r) => r.method === 'PUT').length, 1);

    const remaining = new Map(collected.items);
    remaining.delete(postId.externalId('_posts/one.md'));
    const third = await run(remaining);
    assert.strictEqual(third.removed, 1);
    assert.strictEqual(server.state.posts.size, 1);

    assert.ok(lines.some((l) => l.indexOf('[MomoBird]') === 0), 'log lines carry the prefix');
    assert.ok(server.requests.every((r) => r.authorized));
    assert.strictEqual(JSON.stringify(server.requests).indexOf('mbk_'), -1, 'the key never reaches the mock log');

    await assert.rejects(
      client.createClient({ api: server.url, key: 'mbk_WRONG', retryDelaysMs: [] }).status(),
      (err) => err.kind === 'http' && err.status === 401 && err.message.indexOf('mbk_') === -1
    );
    step('runSync against the mock: push, cache hit, delete, 401');
  } finally {
    await server.close();
    removeDir(dir);
  }
}

// After the plan expires the server refuses pushes (402) but still lists and
// deletes: the posts the site no longer has must still come down.
async function removesAfterExpiry() {
  const gone = postId.externalId('_posts/gone.md');
  const kept = postId.externalId('_posts/one.md');
  const server = await mock.startMock({ siteUrl: SITE_URL, planExpired: true, seed: [kept, gone] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexo-momobird-smoke-'));
  try {
    const api = client.createClient({ api: server.url, key: KEY, retryDelaysMs: [] });
    const collected = posts.collectLocal(
      [fakePost('_posts/one.md', '第一篇', '<p>你好</p>'), fakePost('_posts/new.md', '新文章', '<p>新的</p>')],
      { future: true, now: new Date('2026-11-01T00:00:00Z') }
    );
    const cacheFile = cache.cachePath(dir, mock.SOURCE_ID);
    const report = await reconcile.runSync({ client: api, local: collected.items, cacheFile, prune: false, dryRun: false });

    assert.strictEqual(report.planRequired.length, 2);
    assert.strictEqual(report.removed, 1);
    assert.strictEqual(server.requests.filter((r) => r.method === 'PUT').length, 1);
    assert.deepStrictEqual(server.requests.filter((r) => r.path.slice(-13) === '/posts/delete').map((r) => r.body.external_ids), [[gone]]);
    assert.deepStrictEqual(cache.readCache(cacheFile), {});

    fs.mkdirSync(path.join(dir, 'source', '_posts', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'source', '_posts', 'sub', 'a.md'), 'x');
    fs.writeFileSync(path.join(dir, 'source', '_posts', '.b.md'), 'x');
    assert.deepStrictEqual(posts.listPostFiles(path.join(dir, 'source') + path.sep, () => true), ['_posts/sub/a.md']);
    step('402: pushing stops, the removal still goes out, nothing is cached; listPostFiles');
  } finally {
    await server.close();
    removeDir(dir);
  }
}

async function main() {
  loadsEverything();
  fixedValues();
  registersIntoHexo();
  await syncsAgainstTheMock();
  await removesAfterExpiry();
  process.stdout.write('node14 smoke: all passed on ' + process.version + '\n');
}

main().catch((err) => {
  process.stderr.write('node14 smoke FAILED: ' + (err && err.stack ? err.stack : err) + '\n');
  process.exitCode = 1;
});
