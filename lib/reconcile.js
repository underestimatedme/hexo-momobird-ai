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
// remote order. The prune guard turns a suspicious `remove` into [] (a blog
// that suddenly looks empty or tiny is more likely a broken build than a
// deliberate purge).
function planSync(input) {
  const { local, remoteIds, cache, prune } = input;

  const push = [];
  for (const [id, post] of local) {
    const cached = hasOwn(cache, id) ? cache[id] : undefined;
    if (!remoteIds.has(id) || cached !== post.digest) {
      push.push(id);
    }
  }

  let remove = [];
  for (const id of remoteIds) {
    if (!local.has(id)) {
      remove.push(id);
    }
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

  return { push, remove, pruneSkipped };
}

function malformed(reason) {
  return new ConnectError({ kind: 'network', reason });
}

// Reads every page of the remote listing. A server that keeps handing back a
// cursor it has already sent would otherwise hold the build forever.
async function listRemoteIds(client) {
  const ids = new Set();
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
      }
    }

    const next = page.next_cursor;
    if (next === null || next === undefined || next === '') {
      return ids;
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

function silentLog() {
  const quiet = () => {};
  return { info: quiet, warn: quiet, error: quiet };
}

// Runs one sync. A ConnectError from any call is fatal and propagates before
// anything further is sent: no removals after a failed push, and no cache
// write, so the next build starts from the same state.
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
    removed: 0,
    pruneSkipped: false
  };

  const remoteIds = await listRemoteIds(client);
  const cache = readCache(cacheFile);
  const plan = planSync({ local, remoteIds, cache, prune });
  report.planned = { push: plan.push, remove: plan.remove };
  report.pruneSkipped = plan.pruneSkipped;

  if (plan.pruneSkipped) {
    let wouldRemove = 0;
    for (const id of remoteIds) {
      if (!local.has(id)) wouldRemove += 1;
    }
    log.warn(
      PREFIX + '清理保护：本地 ' + local.size + ' 篇，MomoBird 上有 ' + remoteIds.size + ' 篇，其中 ' +
        wouldRemove + ' 篇本地已没有，已跳过全部下线。确认要下线请加 --prune'
    );
  }

  if (dryRun) {
    log.info(PREFIX + '试运行：将推送 ' + plan.push.length + ' 篇，下线 ' + plan.remove.length + ' 篇，未发送任何改动');
    return report;
  }

  const accepted = new Map();
  const refused = new Set();
  for (let start = 0; start < plan.push.length; start += PUSH_BATCH_SIZE) {
    const batch = plan.push.slice(start, start + PUSH_BATCH_SIZE);
    const results = resultsById(await client.upsertPosts(batch.map((id) => local.get(id).payload)));

    let refusedInBatch = 0;
    for (const id of batch) {
      const post = local.get(id);
      const result = results.get(id);
      const status = result === undefined ? undefined : result.status;
      if (status === 'created' || status === 'updated') {
        report.pushed += 1;
        accepted.set(id, post.digest);
      } else if (status === 'unchanged') {
        report.unchanged += 1;
        accepted.set(id, post.digest);
      } else {
        report.rejected.push({ externalId: id, source: post.source, code: rejectionCode(result) });
        refused.add(id);
        refusedInBatch += 1;
      }
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
  // still there (local, or kept on the remote by the prune guard) minus those
  // just refused or taken down, then the digests it just accepted.
  const next = {};
  for (const id of Object.keys(cache)) {
    if (refused.has(id) || gone.has(id)) continue;
    if (local.has(id) || remoteIds.has(id)) next[id] = cache[id];
  }
  for (const [id, digest] of accepted) {
    next[id] = digest;
  }

  try {
    writeCache(cacheFile, next);
  } catch (err) {
    // The cache is only an optimisation; the sync itself has succeeded.
    log.warn(PREFIX + '缓存写入失败（' + (err && err.message ? err.message : '未知错误') + '），下次构建会重新核对全部文章');
  }

  return report;
}

module.exports = { planSync, runSync };
