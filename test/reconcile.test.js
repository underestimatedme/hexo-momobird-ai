'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planSync, runSync } = require('../lib/reconcile');
const { readCache, writeCache } = require('../lib/cache');
const { ConnectError } = require('../lib/client');

const KEY = 'mbk_live_0123456789abcdefSECRET';
const dirs = [];

function tmpCacheFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexo-momobird-reconcile-'));
  dirs.push(dir);
  return path.join(dir, 'nested', 'src.json');
}

after(() => {
  for (const dir of dirs) {
    fs.rmSync ? fs.rmSync(dir, { recursive: true, force: true }) : fs.rmdirSync(dir, { recursive: true });
  }
});

function ids(prefix, n, from) {
  const out = [];
  for (let i = from || 0; i < (from || 0) + n; i += 1) out.push(prefix + i);
  return out;
}

// Local posts in order, shaped like collectLocal's items.
function localOf(idList) {
  const map = new Map();
  for (const id of idList) {
    map.set(id, {
      externalId: id,
      source: '_posts/' + id + '.md',
      payload: {
        external_id: id,
        title: 'Title ' + id,
        content: 'BODY-OF-' + id,
        url: 'https://blog.example.test/' + id + '/',
        modified_at: '2026-10-01T00:00:00.000Z'
      },
      digest: 'digest-' + id
    });
  }
  return map;
}

function digestsOf(idList) {
  const out = {};
  for (const id of idList) out['' + id] = 'digest-' + id;
  return out;
}

function apiError(status) {
  return new ConnectError({ kind: 'http', status });
}

// A client that records every call. `remote` is the id list the server holds;
// `pages` replaces it with explicit pages keyed by cursor ('' is the first).
// `upsert(posts, n)` and `remove(ids, n)` may return results or throw.
function fakeClient(opts) {
  const o = opts || {};
  const calls = [];
  const pages = o.pages || {
    '': { items: (o.remote || []).map((id) => ({ external_id: id, document_id: 'doc-' + id, updated_at: 'x' })), next_cursor: null }
  };
  let upserts = 0;
  let deletes = 0;
  return {
    calls,
    async listPosts(cursor) {
      calls.push({ op: 'list', cursor });
      const page = pages[cursor || ''];
      if (page instanceof Error) throw page;
      return page;
    },
    async upsertPosts(posts) {
      calls.push({ op: 'upsert', ids: posts.map((p) => p.external_id), posts });
      const n = upserts;
      upserts += 1;
      if (o.upsert) return o.upsert(posts, n);
      return { results: posts.map((p) => ({ external_id: p.external_id, document_id: 'doc-' + p.external_id, status: 'created', error_code: null })) };
    },
    async deletePosts(idList) {
      calls.push({ op: 'delete', ids: idList });
      const n = deletes;
      deletes += 1;
      if (o.remove) return o.remove(idList, n);
      return { results: idList.map((id) => ({ external_id: id, status: 'deleted' })) };
    }
  };
}

function fakeLog() {
  const lines = [];
  const add = (level) => (message) => lines.push({ level, message: String(message) });
  return { lines, info: add('info'), warn: add('warn'), error: add('error') };
}

function ops(client, op) {
  return client.calls.filter((c) => c.op === op);
}

// --- planSync ---------------------------------------------------------------

test('planSync pushes what the remote lacks or the cache has not seen, in local order', () => {
  const local = localOf(['c', 'b', 'a', 'd']);
  const plan = planSync({
    local,
    remoteIds: new Set(['a', 'b', 'd', 'x']),
    cache: { a: 'digest-a', b: 'stale', d: 'digest-d' },
    prune: false
  });
  // c: not on the remote. b: cache digest differs. a, d: up to date.
  assert.deepEqual(plan.push, ['c', 'b']);
  assert.deepEqual(plan.remove, ['x']);
  assert.equal(plan.pruneSkipped, false);
});

test('planSync pushes a post the cache knows but the remote lost', () => {
  const plan = planSync({
    local: localOf(['a', 'b']),
    remoteIds: new Set(['a']),
    cache: digestsOf(['a', 'b']),
    prune: false
  });
  assert.deepEqual(plan.push, ['b']);
});

test('planSync with a complete cache and remote has nothing to do', () => {
  const plan = planSync({
    local: localOf(ids('p', 5)),
    remoteIds: new Set(ids('p', 5)),
    cache: digestsOf(ids('p', 5)),
    prune: false
  });
  assert.deepEqual(plan, { push: [], remove: [], pruneSkipped: false, held: [] });
});

test('planSync takes down what the remote has and the site no longer has', () => {
  const plan = planSync({
    local: localOf(ids('p', 3)),
    remoteIds: new Set([...ids('p', 3), 'old1', 'old2']),
    cache: digestsOf(ids('p', 3)),
    prune: false
  });
  assert.deepEqual(plan.remove, ['old1', 'old2']);
  assert.equal(plan.pruneSkipped, false);
});

test('planSync prune guard: empty local skips every removal', () => {
  const plan = planSync({ local: new Map(), remoteIds: new Set(ids('r', 30)), cache: {}, prune: false });
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.pruneSkipped, true);
});

test('planSync prune guard: more than 10 and more than half skips every removal', () => {
  // 30 on the remote, 14 local: 16 removals, over 10 and over 15.
  const plan = planSync({
    local: localOf(ids('r', 14)),
    remoteIds: new Set(ids('r', 30)),
    cache: digestsOf(ids('r', 14)),
    prune: false
  });
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.pruneSkipped, true);
});

test('planSync prune guard: exactly 10 removals go through', () => {
  const plan = planSync({
    local: localOf(ids('r', 20)),
    remoteIds: new Set(ids('r', 30)),
    cache: digestsOf(ids('r', 20)),
    prune: false
  });
  assert.deepEqual(plan.remove, ids('r', 10, 20));
  assert.equal(plan.pruneSkipped, false);
});

test('planSync prune guard: "more than half" is strict', () => {
  // 22 on the remote, 11 local: 11 removals, over 10 but exactly half.
  const exactlyHalf = planSync({
    local: localOf(ids('r', 11)),
    remoteIds: new Set(ids('r', 22)),
    cache: digestsOf(ids('r', 11)),
    prune: false
  });
  assert.equal(exactlyHalf.remove.length, 11);
  assert.equal(exactlyHalf.pruneSkipped, false);

  // 21 on the remote, 10 local: 11 removals, over 10 and over 10.5.
  const overHalf = planSync({
    local: localOf(ids('r', 10)),
    remoteIds: new Set(ids('r', 21)),
    cache: digestsOf(ids('r', 10)),
    prune: false
  });
  assert.deepEqual(overHalf.remove, []);
  assert.equal(overHalf.pruneSkipped, true);
});

test('planSync prune guard: a few removals from a small blog are never blocked', () => {
  // 8 of 10 removed is more than half, but not more than 10 posts.
  const plan = planSync({
    local: localOf(ids('r', 2)),
    remoteIds: new Set(ids('r', 10)),
    cache: digestsOf(ids('r', 2)),
    prune: false
  });
  assert.equal(plan.remove.length, 8);
  assert.equal(plan.pruneSkipped, false);
});

test('planSync prune guard: 10 removals is not "more than 10", even when it is most of the blog', () => {
  const ten = planSync({
    local: localOf(ids('r', 2)),
    remoteIds: new Set(ids('r', 12)),
    cache: digestsOf(ids('r', 2)),
    prune: false
  });
  assert.equal(ten.remove.length, 10);
  assert.equal(ten.pruneSkipped, false);

  const eleven = planSync({
    local: localOf(ids('r', 2)),
    remoteIds: new Set(ids('r', 13)),
    cache: digestsOf(ids('r', 2)),
    prune: false
  });
  assert.deepEqual(eleven.remove, []);
  assert.equal(eleven.pruneSkipped, true);
});

test('planSync with prune removes everything the site no longer has', () => {
  const empty = planSync({ local: new Map(), remoteIds: new Set(ids('r', 30)), cache: {}, prune: true });
  assert.deepEqual(empty.remove, ids('r', 30));
  assert.equal(empty.pruneSkipped, false);

  const most = planSync({
    local: localOf(ids('r', 14)),
    remoteIds: new Set(ids('r', 30)),
    cache: {},
    prune: true
  });
  assert.equal(most.remove.length, 16);
  assert.equal(most.pruneSkipped, false);
});

test('planSync never removes a post whose file Hexo could not read', () => {
  const plan = planSync({
    local: localOf(['a']),
    remoteIds: new Set(['a', 'broken', 'gone']),
    cache: digestsOf(['a']),
    prune: false,
    unreadable: new Map([['broken', '_posts/broken.md'], ['new-broken', '_posts/new-broken.md']])
  });
  assert.deepEqual(plan.remove, ['gone']);
  assert.deepEqual(plan.held, ['broken']);
  assert.equal(plan.pruneSkipped, false);
});

test('planSync holds unreadable posts even with --prune, and they do not count towards the guard', () => {
  // 13 on the remote, 2 local, 10 unreadable: only 1 removal, well under the guard.
  const unreadable = new Map(ids('u', 10).map((id) => [id, '_posts/' + id + '.md']));
  const remote = new Set(['a', 'b', 'gone'].concat(ids('u', 10)));
  const plan = planSync({ local: localOf(['a', 'b']), remoteIds: remote, cache: {}, prune: false, unreadable });
  assert.deepEqual(plan.remove, ['gone']);
  assert.equal(plan.held.length, 10);
  assert.equal(plan.pruneSkipped, false);

  const pruned = planSync({ local: new Map(), remoteIds: remote, cache: {}, prune: true, unreadable });
  assert.deepEqual(pruned.remove, ['a', 'b', 'gone']);
  assert.equal(pruned.held.length, 10);
});

test('planSync does not report a skipped prune when there was nothing to remove', () => {
  const plan = planSync({ local: new Map(), remoteIds: new Set(), cache: {}, prune: false });
  assert.deepEqual(plan, { push: [], remove: [], pruneSkipped: false, held: [] });
});

// --- runSync ----------------------------------------------------------------

test('no cache pushes everything and removes nothing', async () => {
  const cacheFile = tmpCacheFile();
  const local = localOf(['a', 'b', 'c']);
  const client = fakeClient({
    remote: ['a', 'b', 'c'],
    upsert: (posts) => ({ results: posts.map((p) => ({ external_id: p.external_id, status: 'unchanged', error_code: null })) })
  });

  const report = await runSync({ client, local, cacheFile, prune: false, dryRun: false, log: fakeLog() });

  assert.deepEqual(report.planned, { push: ['a', 'b', 'c'], remove: [] });
  assert.equal(ops(client, 'upsert').length, 1);
  assert.equal(ops(client, 'delete').length, 0);
  assert.equal(report.pushed, 0);
  assert.equal(report.unchanged, 3);
  assert.equal(report.removed, 0);
  assert.equal(report.pruneSkipped, false);
  assert.deepEqual(readCache(cacheFile), digestsOf(['a', 'b', 'c']));
});

test('a cache that matches a complete remote sends no push request', async () => {
  const cacheFile = tmpCacheFile();
  writeCache(cacheFile, digestsOf(['a', 'b', 'c']));
  const client = fakeClient({ remote: ['a', 'b', 'c'] });

  const report = await runSync({ client, local: localOf(['a', 'b', 'c']), cacheFile, prune: false, dryRun: false, log: fakeLog() });

  assert.equal(ops(client, 'upsert').length, 0);
  assert.equal(ops(client, 'delete').length, 0);
  assert.deepEqual(report.planned, { push: [], remove: [] });
  assert.equal(report.pushed, 0);
  assert.equal(report.unchanged, 0);
  assert.deepEqual(readCache(cacheFile), digestsOf(['a', 'b', 'c']));
});

test('45 local posts are pushed in batches of 20, 20 and 5', async () => {
  const names = ids('p', 45);
  const client = fakeClient({ remote: [] });

  const report = await runSync({ client, local: localOf(names), cacheFile: tmpCacheFile(), prune: false, dryRun: false, log: fakeLog() });

  assert.deepEqual(ops(client, 'upsert').map((c) => c.ids.length), [20, 20, 5]);
  assert.deepEqual(ops(client, 'upsert').reduce((all, c) => all.concat(c.ids), []), names);
  assert.equal(report.pushed, 45);
});

test('the push body is the post payload, nothing more', async () => {
  const local = localOf(['a']);
  const client = fakeClient({ remote: [] });
  await runSync({ client, local, cacheFile: tmpCacheFile(), prune: false, dryRun: false, log: fakeLog() });
  assert.deepEqual(ops(client, 'upsert')[0].posts, [local.get('a').payload]);
});

test('pushed counts created and updated, unchanged counts unchanged', async () => {
  const client = fakeClient({
    remote: [],
    upsert: (posts) => ({
      results: [
        { external_id: posts[0].external_id, status: 'created', error_code: null },
        { external_id: posts[1].external_id, status: 'updated', error_code: null },
        { external_id: posts[2].external_id, status: 'unchanged', error_code: null }
      ]
    })
  });
  const report = await runSync({ client, local: localOf(['a', 'b', 'c']), cacheFile: tmpCacheFile(), prune: false, dryRun: false, log: fakeLog() });
  assert.equal(report.pushed, 2);
  assert.equal(report.unchanged, 1);
  assert.deepEqual(report.rejected, []);
});

test('two posts missing from the site are taken down after the push', async () => {
  const cacheFile = tmpCacheFile();
  const client = fakeClient({ remote: ['a', 'b', 'gone1', 'gone2'] });
  writeCache(cacheFile, { ...digestsOf(['a', 'b']), gone1: 'digest-gone1', gone2: 'digest-gone2' });

  const report = await runSync({ client, local: localOf(['a', 'b', 'c']), cacheFile, prune: false, dryRun: false, log: fakeLog() });

  assert.deepEqual(report.planned, { push: ['c'], remove: ['gone1', 'gone2'] });
  assert.deepEqual(ops(client, 'delete').map((c) => c.ids), [['gone1', 'gone2']]);
  assert.equal(report.removed, 2);
  // Pushes come first, removals only after every push went through.
  assert.deepEqual(client.calls.map((c) => c.op), ['list', 'upsert', 'delete']);
  // The taken-down posts leave the cache; the pushed one enters it.
  assert.deepEqual(readCache(cacheFile), digestsOf(['a', 'b', 'c']));
});

test('removals go in batches of 100', async () => {
  const client = fakeClient({ remote: ids('r', 230) });
  const report = await runSync({ client, local: localOf(ids('r', 130)), cacheFile: tmpCacheFile(), prune: true, dryRun: false, log: fakeLog() });
  assert.deepEqual(ops(client, 'delete').map((c) => c.ids.length), [100]);
  assert.equal(report.removed, 100);

  const many = fakeClient({ remote: ids('r', 450) });
  const bigReport = await runSync({ client: many, local: localOf(ids('r', 50)), cacheFile: tmpCacheFile(), prune: true, dryRun: false, log: fakeLog() });
  assert.deepEqual(ops(many, 'delete').map((c) => c.ids.length), [100, 100, 100, 100]);
  assert.equal(bigReport.removed, 400);
});

test('a post already gone from the remote counts as gone, not as removed', async () => {
  const cacheFile = tmpCacheFile();
  writeCache(cacheFile, { a: 'digest-a', gone1: 'digest-gone1', gone2: 'digest-gone2' });
  const client = fakeClient({
    remote: ['a', 'gone1', 'gone2'],
    remove: (idList) => ({
      results: idList.map((id) => ({ external_id: id, status: id === 'gone1' ? 'not_found' : 'deleted' }))
    })
  });

  const report = await runSync({ client, local: localOf(['a']), cacheFile, prune: false, dryRun: false, log: fakeLog() });

  assert.equal(report.removed, 1);
  assert.deepEqual(readCache(cacheFile), { a: 'digest-a' });
});

test('the prune guard skips every removal and says so', async () => {
  const cacheFile = tmpCacheFile();
  const client = fakeClient({ remote: ids('r', 30) });
  const log = fakeLog();

  const report = await runSync({ client, local: new Map(), cacheFile, prune: false, dryRun: false, log });

  assert.equal(report.pruneSkipped, true);
  assert.deepEqual(report.planned, { push: [], remove: [] });
  assert.equal(ops(client, 'delete').length, 0);
  assert.equal(report.removed, 0);
  const warns = log.lines.filter((l) => l.level === 'warn');
  assert.equal(warns.length, 1);
  assert.ok(warns[0].message.startsWith('[MomoBird]'), warns[0].message);
  // `hexo generate` has no --prune flag; the warning must name the command that does.
  assert.ok(warns[0].message.includes('hexo momobird sync --prune'), warns[0].message);
  assert.ok(!/hexo g(enerate)?\b/.test(warns[0].message), warns[0].message);
});

test('the prune guard also holds when only 14 of 30 posts are left', async () => {
  const client = fakeClient({ remote: ids('r', 30) });
  const report = await runSync({ client, local: localOf(ids('r', 14)), cacheFile: tmpCacheFile(), prune: false, dryRun: false, log: fakeLog() });
  assert.equal(report.pruneSkipped, true);
  assert.equal(ops(client, 'delete').length, 0);
});

test('10 removals of 30 are allowed without --prune', async () => {
  const client = fakeClient({ remote: ids('r', 30) });
  const report = await runSync({ client, local: localOf(ids('r', 20)), cacheFile: tmpCacheFile(), prune: false, dryRun: false, log: fakeLog() });
  assert.equal(report.pruneSkipped, false);
  assert.equal(report.removed, 10);
});

test('--prune removes even when the site is empty', async () => {
  const client = fakeClient({ remote: ids('r', 30) });
  const report = await runSync({ client, local: new Map(), cacheFile: tmpCacheFile(), prune: true, dryRun: false, log: fakeLog() });
  assert.equal(report.pruneSkipped, false);
  assert.equal(report.removed, 30);
  assert.deepEqual(ops(client, 'delete').map((c) => c.ids.length), [30]);
});

test('a skipped prune keeps the cache of posts the remote still holds', async () => {
  const cacheFile = tmpCacheFile();
  writeCache(cacheFile, digestsOf(['a', 'b']));
  const client = fakeClient({ remote: ids('r', 30).concat(['a', 'b']) });

  await runSync({ client, local: new Map(), cacheFile, prune: false, dryRun: false, log: fakeLog() });

  // Nothing was taken down, so the remote still holds a and b as cached.
  assert.deepEqual(readCache(cacheFile), digestsOf(['a', 'b']));
});

test('a 500 on the second push batch throws, takes nothing down and writes no cache', async () => {
  const cacheFile = tmpCacheFile();
  const client = fakeClient({
    remote: ids('p', 45).concat(['gone1', 'gone2']),
    upsert: (posts, n) => {
      if (n === 1) throw apiError(500);
      return { results: posts.map((p) => ({ external_id: p.external_id, status: 'created', error_code: null })) };
    }
  });

  await assert.rejects(
    runSync({ client, local: localOf(ids('p', 45)), cacheFile, prune: false, dryRun: false, log: fakeLog() }),
    (err) => {
      assert.ok(err instanceof ConnectError);
      assert.equal(err.status, 500);
      return true;
    }
  );

  assert.equal(ops(client, 'upsert').length, 2);
  assert.equal(ops(client, 'delete').length, 0);
  assert.equal(fs.existsSync(cacheFile), false);
});

test('a fatal error keeps the cache, minus the posts it was about to push', async () => {
  const cacheFile = tmpCacheFile();
  writeCache(cacheFile, { a: 'old', b: 'digest-b' });
  const client = fakeClient({ remote: ['b'], upsert: () => { throw apiError(401); } });

  await assert.rejects(
    runSync({ client, local: localOf(['a', 'b']), cacheFile, prune: false, dryRun: false, log: fakeLog() }),
    (err) => err instanceof ConnectError && err.status === 401
  );
  assert.deepEqual(readCache(cacheFile), { b: 'digest-b' });
});

test('a fatal error while taking posts down throws and writes no cache', async () => {
  const cacheFile = tmpCacheFile();
  const client = fakeClient({ remote: ['a', 'gone'], remove: () => { throw apiError(500); } });

  await assert.rejects(
    runSync({ client, local: localOf(['a']), cacheFile, prune: false, dryRun: false, log: fakeLog() }),
    (err) => err instanceof ConnectError
  );
  assert.equal(fs.existsSync(cacheFile), false);
});

test('a fatal error while listing throws before anything is sent', async () => {
  const client = fakeClient({ pages: { '': apiError(402) } });
  await assert.rejects(
    runSync({ client, local: localOf(['a']), cacheFile: tmpCacheFile(), prune: false, dryRun: false, log: fakeLog() }),
    (err) => err instanceof ConnectError && err.status === 402
  );
  assert.deepEqual(client.calls.map((c) => c.op), ['list']);
});

test('a rejected post is reported, kept out of the cache, and the rest carry on', async () => {
  const cacheFile = tmpCacheFile();
  // The bad post had an older digest cached; a rejection must not keep it.
  writeCache(cacheFile, { b: 'older', gone: 'digest-gone' });
  const client = fakeClient({
    remote: ['a', 'b', 'c', 'gone'],
    upsert: (posts) => ({
      results: posts.map((p) =>
        p.external_id === 'b'
          ? { external_id: 'b', document_id: null, status: 'rejected', error_code: 'VALIDATION_FAILED' }
          : { external_id: p.external_id, status: 'created', error_code: null }
      )
    })
  });

  const report = await runSync({ client, local: localOf(['a', 'b', 'c']), cacheFile, prune: false, dryRun: false, log: fakeLog() });

  assert.deepEqual(report.rejected, [{ externalId: 'b', source: '_posts/b.md', code: 'VALIDATION_FAILED' }]);
  assert.equal(report.pushed, 2);
  assert.deepEqual(readCache(cacheFile), digestsOf(['a', 'c']));
  // The removal still happens.
  assert.deepEqual(ops(client, 'delete').map((c) => c.ids), [['gone']]);
  assert.equal(report.removed, 1);
});

test('a post the server left out of its answer is not cached and is reported', async () => {
  const cacheFile = tmpCacheFile();
  const client = fakeClient({
    remote: [],
    upsert: (posts) => ({ results: [{ external_id: posts[0].external_id, status: 'created', error_code: null }] })
  });

  const report = await runSync({ client, local: localOf(['a', 'b']), cacheFile, prune: false, dryRun: false, log: fakeLog() });

  assert.equal(report.pushed, 1);
  assert.equal(report.rejected.length, 1);
  assert.equal(report.rejected[0].externalId, 'b');
  assert.equal(report.rejected[0].source, '_posts/b.md');
  assert.deepEqual(readCache(cacheFile), digestsOf(['a']));
});

function tooLarge() {
  return new ConnectError({ kind: 'http', status: 413, code: 'PAYLOAD_TOO_LARGE' });
}

function created(posts) {
  return { results: posts.map((p) => ({ external_id: p.external_id, status: 'created', error_code: null })) };
}

test('a 413 on a batch resends its posts one at a time; the oversized post is rejected', async () => {
  const cacheFile = tmpCacheFile();
  const log = fakeLog();
  const client = fakeClient({
    remote: ['gone'],
    upsert: (posts, n) => {
      if (n === 0) throw tooLarge();
      if (posts.length === 1 && posts[0].external_id === 'b') throw tooLarge();
      return created(posts);
    }
  });

  const report = await runSync({ client, local: localOf(['a', 'b', 'c']), cacheFile, prune: true, dryRun: false, log });

  assert.deepEqual(ops(client, 'upsert').map((c) => c.ids), [['a', 'b', 'c'], ['a'], ['b'], ['c']]);
  assert.deepEqual(report.rejected, [{ externalId: 'b', source: '_posts/b.md', code: 'PAYLOAD_TOO_LARGE' }]);
  assert.equal(report.pushed, 2);
  assert.deepEqual(readCache(cacheFile), digestsOf(['a', 'c']));
  // Nothing fatal happened, so the removal still runs.
  assert.deepEqual(ops(client, 'delete').map((c) => c.ids), [['gone']]);
  assert.equal(report.removed, 1);
  // Still one progress line for the batch, with the rejection counted.
  const progress = log.lines.filter((l) => l.message.includes('已推送'));
  assert.equal(progress.length, 1);
  assert.ok(progress[0].message.includes('1 篇被拒绝'), progress[0].message);
});

test('a 413 on a single-post batch is that post rejected, with no resend', async () => {
  const cacheFile = tmpCacheFile();
  writeCache(cacheFile, { big: 'older', ok: 'digest-ok' });
  const client = fakeClient({
    remote: ['ok', 'big', 'gone'],
    upsert: (posts) => {
      throw tooLarge();
    }
  });

  const report = await runSync({ client, local: localOf(['big']), cacheFile, prune: true, dryRun: false, log: fakeLog() });

  assert.deepEqual(ops(client, 'upsert').map((c) => c.ids), [['big']]);
  assert.deepEqual(report.rejected, [{ externalId: 'big', source: '_posts/big.md', code: 'PAYLOAD_TOO_LARGE' }]);
  assert.equal(report.pushed, 0);
  assert.deepEqual(readCache(cacheFile), {});
  assert.deepEqual(ops(client, 'delete').map((c) => c.ids), [['ok', 'gone']]);
});

test('a 413 only affects its own batch; the other batches are sent as usual', async () => {
  const names = ids('p', 45);
  const client = fakeClient({
    remote: [],
    upsert: (posts, n) => {
      // Second call is the second batch of 20: its 413 is split, p25 stays too large.
      if (n === 1) throw tooLarge();
      if (posts.length === 1 && posts[0].external_id === 'p25') throw tooLarge();
      return created(posts);
    }
  });

  const report = await runSync({ client, local: localOf(names), cacheFile: tmpCacheFile(), prune: false, dryRun: false, log: fakeLog() });

  const sizes = ops(client, 'upsert').map((c) => c.ids.length);
  assert.deepEqual(sizes, [20, 20].concat(new Array(20).fill(1), [5]));
  assert.deepEqual(report.rejected.map((r) => r.externalId), ['p25']);
  assert.equal(report.pushed, 44);
});

test('a 500 during the one-at-a-time resend is still fatal: no removals, no cache', async () => {
  const cacheFile = tmpCacheFile();
  const client = fakeClient({
    remote: ['a', 'b', 'c', 'gone'],
    upsert: (posts, n) => {
      if (n === 0) throw tooLarge();
      if (posts[0].external_id === 'b') throw apiError(500);
      return created(posts);
    }
  });

  await assert.rejects(
    runSync({ client, local: localOf(['a', 'b', 'c']), cacheFile, prune: true, dryRun: false, log: fakeLog() }),
    (err) => err instanceof ConnectError && err.status === 500
  );

  // The batch, then a, then the failing b; c is never tried.
  assert.deepEqual(ops(client, 'upsert').map((c) => c.ids), [['a', 'b', 'c'], ['a'], ['b']]);
  assert.equal(ops(client, 'delete').length, 0);
  assert.equal(fs.existsSync(cacheFile), false);
});

test('a 413 is only a rejection for http errors; other statuses and network errors stay fatal', async () => {
  for (const error of [apiError(400), apiError(401), new ConnectError({ kind: 'network', reason: 'boom' })]) {
    const client = fakeClient({ remote: [], upsert: () => { throw error; } });
    await assert.rejects(
      runSync({ client, local: localOf(['a', 'b']), cacheFile: tmpCacheFile(), prune: false, dryRun: false, log: fakeLog() }),
      (err) => err === error
    );
    assert.equal(ops(client, 'upsert').length, 1);
  }
});

test('a post Hexo could not read stays online, with one warning naming its file', async () => {
  const cacheFile = tmpCacheFile();
  writeCache(cacheFile, digestsOf(['a', 'broken']));
  const log = fakeLog();
  const client = fakeClient({ remote: ['a', 'broken', 'gone'] });

  const report = await runSync({
    client,
    local: localOf(['a']),
    cacheFile,
    prune: false,
    dryRun: false,
    log,
    unreadable: new Map([['broken', '_posts/broken.md'], ['offline', '_posts/offline.md']])
  });

  assert.deepEqual(ops(client, 'delete').map((c) => c.ids), [['gone']]);
  assert.deepEqual(report.planned.remove, ['gone']);
  assert.deepEqual(report.held, ['broken']);
  const warnings = log.lines.filter((l) => l.level === 'warn').map((l) => l.message);
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.ok(warnings[0].startsWith('[MomoBird] Hexo 没能读取这篇文章，暂不下线：_posts/broken.md'), warnings[0]);
  assert.ok(warnings[0].includes('front-matter'), warnings[0]);
  // Still on MomoBird, so its record stays.
  assert.deepEqual(readCache(cacheFile), digestsOf(['a', 'broken']));
});

test('a dry run warns about a post Hexo could not read as well', async () => {
  const log = fakeLog();
  const client = fakeClient({ remote: ['broken'] });

  const report = await runSync({
    client,
    local: new Map(),
    cacheFile: tmpCacheFile(),
    prune: true,
    dryRun: true,
    log,
    unreadable: new Map([['broken', '_posts/broken.md']])
  });

  assert.deepEqual(report.planned.remove, []);
  assert.ok(log.lines.some((l) => l.level === 'warn' && l.message.includes('_posts/broken.md')));
});

test('holdRemovals pushes as usual but takes nothing down, and counts what it kept', async () => {
  const client = fakeClient({ remote: ['a', 'other1', 'other2', 'broken'] });
  const log = fakeLog();

  const report = await runSync({
    client,
    local: localOf(['a', 'b']),
    cacheFile: tmpCacheFile(),
    prune: false,
    dryRun: false,
    log,
    holdRemovals: true,
    unreadable: new Map([['broken', '_posts/broken.md']])
  });

  assert.deepEqual(client.calls.map((c) => c.op), ['list', 'upsert']);
  assert.deepEqual(report.planned.remove, []);
  assert.equal(report.withheld, 2);
  assert.equal(report.pruneSkipped, false);
  assert.ok(!log.lines.some((l) => l.message.includes('清理保护')), 'the guard is not what kept them');
});

test('without holdRemovals nothing is withheld', async () => {
  const report = await runSync({ client: fakeClient({ remote: ['gone'] }), local: localOf(['a']), cacheFile: tmpCacheFile(), prune: false, dryRun: false, log: fakeLog() });
  assert.equal(report.withheld, 0);
  assert.equal(report.removed, 1);
});

// --- 402: the plan expired -----------------------------------------------------

// The server refuses pushes once the plan has expired, but still lists and
// deletes, so a post that was deleted or hidden must still come down.
function planRequired() {
  return new ConnectError({ kind: 'http', status: 402, code: 'PLAN_REQUIRED' });
}

test('402 on push still takes down removed or hidden posts', async () => {
  const cacheFile = tmpCacheFile();
  // a was accepted earlier and has not changed; b changed since; c is new;
  // gone was deleted or hidden on the site.
  writeCache(cacheFile, { a: 'digest-a', b: 'digest-b-before', gone: 'digest-gone' });
  const log = fakeLog();
  const client = fakeClient({
    remote: ['a', 'b', 'gone'],
    upsert: () => {
      throw planRequired();
    }
  });

  const report = await runSync({ client, local: localOf(['a', 'b', 'c']), cacheFile, prune: false, dryRun: false, log });

  // One push request, refused; nothing more is pushed.
  assert.deepEqual(ops(client, 'upsert').map((c) => c.ids), [['b', 'c']]);
  assert.deepEqual(report.planRequired, ['b', 'c']);
  assert.deepEqual(report.rejected, []);
  assert.equal(report.pushed, 0);
  assert.equal(report.unchanged, 0);
  // The removal still goes out, after the refused push.
  assert.deepEqual(client.calls.map((c) => c.op), ['list', 'upsert', 'delete']);
  assert.deepEqual(ops(client, 'delete').map((c) => c.ids), [['gone']]);
  assert.equal(report.removed, 1);
  // The cache holds only what the server accepted: a, from before. Not b (its
  // old digest would hide the change from the next build), not c, not gone.
  assert.deepEqual(readCache(cacheFile), { a: 'digest-a' });
  for (const line of log.lines) {
    assert.ok(line.message.startsWith('[MomoBird]'), line.message);
  }
});

test('402 on a later batch keeps the batches already accepted and stops pushing', async () => {
  const cacheFile = tmpCacheFile();
  const names = ids('p', 45);
  const client = fakeClient({
    remote: ['gone1', 'gone2'],
    upsert: (posts, n) => {
      if (n === 1) throw planRequired();
      return created(posts);
    }
  });

  const report = await runSync({ client, local: localOf(names), cacheFile, prune: false, dryRun: false, log: fakeLog() });

  // The first batch went through, the second was refused, the third never sent.
  assert.deepEqual(ops(client, 'upsert').map((c) => c.ids.length), [20, 20]);
  assert.equal(report.pushed, 20);
  assert.deepEqual(report.planRequired, names.slice(20));
  assert.deepEqual(report.rejected, []);
  assert.deepEqual(ops(client, 'delete').map((c) => c.ids), [['gone1', 'gone2']]);
  assert.equal(report.removed, 2);
  assert.deepEqual(readCache(cacheFile), digestsOf(names.slice(0, 20)));
});

test('402 while resending a too-large batch one post at a time stops there too', async () => {
  const cacheFile = tmpCacheFile();
  const client = fakeClient({
    remote: ['gone'],
    upsert: (posts, n) => {
      if (n === 0) throw tooLarge();
      if (posts[0].external_id === 'b') throw planRequired();
      return created(posts);
    }
  });

  const report = await runSync({ client, local: localOf(['a', 'b', 'c']), cacheFile, prune: false, dryRun: false, log: fakeLog() });

  assert.deepEqual(ops(client, 'upsert').map((c) => c.ids), [['a', 'b', 'c'], ['a'], ['b']]);
  assert.equal(report.pushed, 1);
  assert.deepEqual(report.planRequired, ['b', 'c']);
  assert.deepEqual(report.rejected, []);
  assert.deepEqual(ops(client, 'delete').map((c) => c.ids), [['gone']]);
  assert.deepEqual(readCache(cacheFile), digestsOf(['a']));
});

test('402 still respects the prune guard', async () => {
  // 30 on the remote, 14 posts on the site (13 still on the remote, one new):
  // 17 removals is more than 10 and more than half, so the guard holds even
  // after a 402.
  const local = localOf(ids('r', 13).concat(['new']));
  const guarded = fakeClient({ remote: ids('r', 30), upsert: () => { throw planRequired(); } });
  const log = fakeLog();

  const report = await runSync({ client: guarded, local, cacheFile: tmpCacheFile(), prune: false, dryRun: false, log });

  assert.equal(report.pruneSkipped, true);
  assert.equal(report.planRequired.length, 14);
  assert.equal(ops(guarded, 'delete').length, 0);
  assert.equal(report.removed, 0);
  assert.ok(log.lines.some((l) => l.level === 'warn' && l.message.includes('hexo momobird sync --prune')));

  // With --prune the same removals go out.
  const pruned = fakeClient({ remote: ids('r', 30), upsert: () => { throw planRequired(); } });
  const prunedReport = await runSync({ client: pruned, local, cacheFile: tmpCacheFile(), prune: true, dryRun: false, log: fakeLog() });
  assert.equal(prunedReport.pruneSkipped, false);
  assert.equal(prunedReport.removed, 17);
  assert.deepEqual(ops(pruned, 'delete').map((c) => c.ids), [ids('r', 17, 13)]);
});

test('a 402 when listing or taking posts down is still fatal', async () => {
  const listing = fakeClient({ pages: { '': planRequired() } });
  await assert.rejects(
    runSync({ client: listing, local: localOf(['a']), cacheFile: tmpCacheFile(), prune: false, dryRun: false, log: fakeLog() }),
    (err) => err instanceof ConnectError && err.status === 402
  );

  const removing = fakeClient({ remote: ['gone'], remove: () => { throw planRequired(); } });
  await assert.rejects(
    runSync({ client: removing, local: new Map([['a', localOf(['a']).get('a')]]), cacheFile: tmpCacheFile(), prune: false, dryRun: false, log: fakeLog() }),
    (err) => err instanceof ConnectError && err.status === 402
  );
});

test('a run without a 402 reports no plan-required posts', async () => {
  const report = await runSync({ client: fakeClient({ remote: [] }), local: localOf(['a']), cacheFile: tmpCacheFile(), prune: false, dryRun: false, log: fakeLog() });
  assert.deepEqual(report.planRequired, []);
});

test('a dry run only lists and writes no cache', async () => {
  const cacheFile = tmpCacheFile();
  const before = digestsOf(['a']);
  writeCache(cacheFile, before);
  const client = fakeClient({ remote: ['a', 'gone'] });

  const report = await runSync({ client, local: localOf(['a', 'b']), cacheFile, prune: false, dryRun: true, log: fakeLog() });

  assert.deepEqual(client.calls.map((c) => c.op), ['list']);
  assert.deepEqual(report.planned, { push: ['b'], remove: ['gone'] });
  assert.equal(report.pushed, 0);
  assert.equal(report.unchanged, 0);
  assert.equal(report.removed, 0);
  assert.deepEqual(report.rejected, []);
  assert.deepEqual(readCache(cacheFile), before);
});

test('a dry run reports a skipped prune as well', async () => {
  const client = fakeClient({ remote: ids('r', 30) });
  const report = await runSync({ client, local: new Map(), cacheFile: tmpCacheFile(), prune: false, dryRun: true, log: fakeLog() });
  assert.equal(report.pruneSkipped, true);
  assert.deepEqual(report.planned, { push: [], remove: [] });
});

test('the remote listing follows next_cursor until it is null', async () => {
  const item = (id) => ({ external_id: id, document_id: 'doc-' + id, updated_at: 'x' });
  const client = fakeClient({
    pages: {
      '': { items: [item('a'), item('b')], next_cursor: 'c1' },
      c1: { items: [item('c')], next_cursor: 'c2' },
      c2: { items: [item('gone')], next_cursor: null }
    }
  });

  const cacheFile = tmpCacheFile();
  writeCache(cacheFile, digestsOf(['a', 'b', 'c']));
  const report = await runSync({ client, local: localOf(['a', 'b', 'c']), cacheFile, prune: false, dryRun: true, log: fakeLog() });

  assert.deepEqual(ops(client, 'list').map((c) => c.cursor), [undefined, 'c1', 'c2']);
  assert.deepEqual(report.planned.remove, ['gone']);
  assert.deepEqual(report.planned.push, []);
});

test('a server that repeats a cursor stops the sync instead of looping', async () => {
  const item = (id) => ({ external_id: id, document_id: 'doc-' + id, updated_at: 'x' });
  const client = fakeClient({
    pages: {
      '': { items: [item('a')], next_cursor: 'c1' },
      c1: { items: [item('b')], next_cursor: 'c1' }
    }
  });

  await assert.rejects(
    runSync({ client, local: localOf(['a']), cacheFile: tmpCacheFile(), prune: false, dryRun: false, log: fakeLog() }),
    (err) => err instanceof ConnectError
  );
  assert.deepEqual(ops(client, 'list').map((c) => c.cursor), [undefined, 'c1']);
  assert.equal(ops(client, 'upsert').length, 0);
  assert.equal(ops(client, 'delete').length, 0);
});

test('a server that sends a cursor it already sent earlier also stops the sync', async () => {
  const item = (id) => ({ external_id: id, document_id: 'doc-' + id, updated_at: 'x' });
  const client = fakeClient({
    pages: {
      '': { items: [item('a')], next_cursor: 'c1' },
      c1: { items: [item('b')], next_cursor: 'c2' },
      c2: { items: [item('c')], next_cursor: 'c1' }
    }
  });
  await assert.rejects(
    runSync({ client, local: localOf(['a']), cacheFile: tmpCacheFile(), prune: false, dryRun: true, log: fakeLog() }),
    (err) => err instanceof ConnectError
  );
  assert.equal(ops(client, 'list').length, 3);
});

test('a malformed listing page is a fatal error, not an empty remote', async () => {
  const client = fakeClient({ pages: { '': { next_cursor: null } } });
  await assert.rejects(
    runSync({ client, local: localOf(['a']), cacheFile: tmpCacheFile(), prune: true, dryRun: false, log: fakeLog() }),
    (err) => err instanceof ConnectError
  );
  assert.deepEqual(client.calls.map((c) => c.op), ['list']);
});

test('cache entries are kept for posts that were not pushed this time', async () => {
  const cacheFile = tmpCacheFile();
  writeCache(cacheFile, digestsOf(['a', 'b']));
  const client = fakeClient({ remote: ['a', 'b'] });

  await runSync({ client, local: localOf(['a', 'b', 'c']), cacheFile, prune: false, dryRun: false, log: fakeLog() });

  assert.deepEqual(ops(client, 'upsert').map((c) => c.ids), [['c']]);
  assert.deepEqual(readCache(cacheFile), digestsOf(['a', 'b', 'c']));
});

test('a changed post is pushed again and its new digest replaces the old one', async () => {
  const cacheFile = tmpCacheFile();
  writeCache(cacheFile, { a: 'digest-a-old' });
  const client = fakeClient({
    remote: ['a'],
    upsert: (posts) => ({ results: posts.map((p) => ({ external_id: p.external_id, status: 'updated', error_code: null })) })
  });

  const report = await runSync({ client, local: localOf(['a']), cacheFile, prune: false, dryRun: false, log: fakeLog() });

  assert.equal(report.pushed, 1);
  assert.deepEqual(readCache(cacheFile), { a: 'digest-a' });
});

// Cache entries must never outlive a push that may have reached the server.
// Here the server stores the edited versions but the answer is lost; the
// author then reverts the edits. Had the cache kept the old digests, they
// would match again and MomoBird would keep the edited text for good.
test('an aborted run leaves the posts it was pushing out of the cache, so the next run pushes them again', async () => {
  const cacheFile = tmpCacheFile();
  writeCache(cacheFile, digestsOf(['a', 'b', 'c']));

  const edited = localOf(['a', 'b', 'c']);
  edited.get('a').digest = 'digest-a-edited';
  edited.get('b').digest = 'digest-b-edited';
  const dropped = fakeClient({
    remote: ['a', 'b', 'c'],
    upsert: () => {
      throw new ConnectError({ kind: 'network', reason: 'socket hang up' });
    }
  });
  await assert.rejects(
    runSync({ client: dropped, local: edited, cacheFile, prune: false, dryRun: false, log: fakeLog() }),
    (err) => err instanceof ConnectError && err.kind === 'network'
  );
  assert.deepEqual(ops(dropped, 'upsert').map((c) => c.ids), [['a', 'b']]);
  // c was not part of the push and keeps its record.
  assert.deepEqual(readCache(cacheFile), digestsOf(['c']));

  // The edits are reverted: a and b are back to the versions cached before.
  const next = fakeClient({ remote: ['a', 'b', 'c'] });
  await runSync({ client: next, local: localOf(['a', 'b', 'c']), cacheFile, prune: false, dryRun: false, log: fakeLog() });

  assert.deepEqual(ops(next, 'upsert').map((c) => c.ids), [['a', 'b']]);
  assert.deepEqual(readCache(cacheFile), digestsOf(['a', 'b', 'c']));
});

test('a cache that cannot be rewritten before the push is a warning, and the sync goes on', { skip: process.getuid && process.getuid() === 0 ? 'root ignores directory permissions' : false }, async () => {
  const cacheFile = tmpCacheFile();
  writeCache(cacheFile, { a: 'digest-a-old', b: 'digest-b' });
  const dir = path.dirname(cacheFile);
  fs.chmodSync(dir, 0o500);
  const log = fakeLog();
  try {
    const client = fakeClient({ remote: ['a', 'b'] });
    const report = await runSync({ client, local: localOf(['a', 'b']), cacheFile, prune: false, dryRun: false, log });

    assert.deepEqual(ops(client, 'upsert').map((c) => c.ids), [['a']]);
    assert.equal(report.pushed, 1);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  const warnings = log.lines.filter((l) => l.level === 'warn');
  assert.equal(warnings.length, 1, warnings.map((l) => l.message).join('\n'));
  assert.ok(warnings[0].message.startsWith('[MomoBird]'), warnings[0].message);
  assert.ok(warnings[0].message.includes('缓存'), warnings[0].message);
});

test('a cache that cannot be written is a warning, not a failed sync', async () => {
  const cacheFile = tmpCacheFile();
  // A directory sits where the cache file should go, so the rename fails.
  fs.mkdirSync(cacheFile, { recursive: true });
  const log = fakeLog();

  const report = await runSync({ client: fakeClient({ remote: [] }), local: localOf(['a']), cacheFile, prune: false, dryRun: false, log });

  assert.equal(report.pushed, 1);
  assert.ok(log.lines.some((l) => l.level === 'warn' && l.message.includes('[MomoBird]')));
});

test('logs are Chinese, prefixed, one line per batch, and never carry bodies or the key', async () => {
  const log = fakeLog();
  const client = fakeClient({ remote: ids('r', 3) });

  await runSync({ client, local: localOf(ids('p', 45)), cacheFile: tmpCacheFile(), prune: true, dryRun: false, log });

  assert.ok(log.lines.length > 0);
  for (const line of log.lines) {
    assert.ok(line.message.startsWith('[MomoBird]'), line.message);
    assert.ok(!line.message.includes('BODY-OF-'), line.message);
    assert.ok(!line.message.includes(KEY), line.message);
    assert.ok(!line.message.includes('mbk_'), line.message);
    assert.ok(/[一-鿿]/.test(line.message), line.message);
  }
  // 3 push batches + 1 removal batch, plus at most a couple of summary lines.
  assert.ok(log.lines.length <= 6, 'got ' + log.lines.length + ' lines');
});

test('runSync works without a logger', async () => {
  const report = await runSync({ client: fakeClient({ remote: [] }), local: localOf(['a']), cacheFile: tmpCacheFile(), prune: false, dryRun: false });
  assert.equal(report.pushed, 1);
});
