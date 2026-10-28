#!/usr/bin/env node
'use strict';

// A stand-in for MomoBird's connect API, for local and CI checks of the plugin.
// It keeps everything in memory, checks the Bearer key, and appends one JSON
// line per request to the file given with --log. Not shipped in the package
// (`files` in package.json leaves dev/ out).
//
//   node dev/mock-connect.js --site-url https://hexo.example.com \
//        --log /tmp/mock.jsonl [--port 0] [--port-file /tmp/mock.port] \
//        [--put-status 500] [--plan expired] [--seed 123,456]
//
//   --site-url     the source's site_url as /status reports it (required)
//   --log          JSON Lines file for the request log (default: none)
//   --port         port on 127.0.0.1; 0 or absent lets the OS pick one
//   --port-file    where to write the chosen port once the server listens
//   --put-status   answer PUT /posts with this error status instead of storing
//   --plan         `expired`: the plan has run out. Like MomoBird, the mock
//                  then answers PUT /posts and POST /widget/enable with 402
//                  PLAN_REQUIRED, and keeps listing and deleting posts.
//                  /status reports the expired plan; the widget state is left
//                  at not_published, so a plugin that tried to switch it on
//                  after a 402 would show up in the log.
//   --seed         comma-separated external ids MomoBird already holds
//
// Written for Node 14 as well as newer versions: no optional chaining, no
// global fetch.

const fs = require('fs');
const http = require('http');
const { URL } = require('url');

const PREFIX = '/momobird/api/public/connect/v1';
const KEY = 'mbk_HEXOLOCALTESTKEYHEXOLOCALTESTKEYHEXOLOCAL';
const SOURCE_ID = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const WIDGET_PUBLIC_ID = 'pub_hexo_local';
const MAX_BODY_BYTES = 5 * 1024 * 1024;

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text)
  });
  res.end(text);
}

function ok(res, data) {
  send(res, 200, { code: 'OK', data });
}

function fail(res, status, code, message) {
  send(res, status, { code, message });
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch (err) {
    return null;
  }
}

// opts.siteUrl     required
// opts.logFile     optional path; every request is appended as one JSON line
// opts.port        optional; 0 / undefined = OS-assigned
// opts.putStatus   optional; PUT /posts fails with this status
// opts.planExpired optional; PUT /posts and POST /widget/enable answer 402
// opts.seed        optional; external ids the mock holds from the start
function startMock(opts) {
  const options = opts || {};
  if (!options.siteUrl) throw new Error('startMock needs siteUrl');
  const siteOrigin = originOf(options.siteUrl);
  if (siteOrigin === null) throw new Error('siteUrl is not a URL');

  const state = {
    posts: new Map(),
    widget: { public_id: WIDGET_PUBLIC_ID, available: false, reason: 'not_published' }
  };
  for (const id of options.seed || []) {
    state.posts.set(String(id), { external_id: String(id), seeded: true });
  }
  const requests = [];

  function record(entry) {
    requests.push(entry);
    if (options.logFile) {
      fs.appendFileSync(options.logFile, JSON.stringify(entry) + '\n');
    }
  }

  function statusData() {
    return {
      project: { id: 'p-hexo-local', name: 'Hexo 本地测试项目' },
      source: {
        id: SOURCE_ID,
        kind: 'hexo',
        name: 'Hexo 本地来源',
        site_url: options.siteUrl,
        document_count: state.posts.size,
        ready_document_count: state.posts.size
      },
      entitlement: options.planExpired
        ? {
            status: 'expired',
            active: false,
            trial_ends_at: new Date(Date.now() - 86400 * 1000).toISOString(),
            pro_ends_at: null
          }
        : {
            status: 'trial',
            active: true,
            trial_ends_at: new Date(Date.now() + 6 * 86400 * 1000).toISOString(),
            pro_ends_at: null
          },
      widget: Object.assign({}, state.widget)
    };
  }

  function listPosts(res, query) {
    const limit = Math.min(Math.max(parseInt(query.get('limit') || '500', 10) || 500, 1), 500);
    const offset = Math.max(parseInt(query.get('cursor') || '0', 10) || 0, 0);
    const ids = Array.from(state.posts.keys());
    const page = ids.slice(offset, offset + limit);
    const next = offset + limit < ids.length ? String(offset + limit) : null;
    ok(res, {
      items: page.map((id) => ({ external_id: id, document_id: 'doc-' + id })),
      next_cursor: next
    });
  }

  function planRequired(res) {
    fail(res, 402, 'PLAN_REQUIRED', 'an active plan is required');
  }

  function putPosts(res, body) {
    if (options.planExpired) {
      planRequired(res);
      return;
    }
    if (options.putStatus) {
      fail(res, options.putStatus, 'MOCK_FAILURE', 'mock PUT failure');
      return;
    }
    const posts = body && Array.isArray(body.posts) ? body.posts : null;
    if (posts === null || posts.length === 0 || posts.length > 20) {
      fail(res, 400, 'VALIDATION_FAILED', 'posts must hold 1 to 20 items');
      return;
    }
    const results = posts.map((post) => {
      const id = post && typeof post.external_id === 'string' ? post.external_id : '';
      const valid =
        /^[0-9]{1,20}$/.test(id) &&
        typeof post.title === 'string' && post.title !== '' &&
        typeof post.content === 'string' && post.content !== '' &&
        typeof post.url === 'string' &&
        originOf(post.url) === siteOrigin;
      if (!valid) {
        return { external_id: id, document_id: null, status: 'rejected', error_code: 'VALIDATION_FAILED' };
      }
      const before = state.posts.get(id);
      let outcome = 'created';
      if (before !== undefined) {
        outcome = JSON.stringify(before) === JSON.stringify(post) ? 'unchanged' : 'updated';
      }
      state.posts.set(id, post);
      return { external_id: id, document_id: 'doc-' + id, status: outcome, error_code: null };
    });
    ok(res, { results });
  }

  function deletePosts(res, body) {
    const ids = body && Array.isArray(body.external_ids) ? body.external_ids : null;
    if (ids === null || ids.length === 0 || ids.length > 100) {
      fail(res, 400, 'VALIDATION_FAILED', 'external_ids must hold 1 to 100 items');
      return;
    }
    const results = ids.map((id) => {
      const had = state.posts.delete(String(id));
      return { external_id: String(id), status: had ? 'deleted' : 'not_found' };
    });
    ok(res, { results });
  }

  function enableWidget(res) {
    if (options.planExpired) {
      planRequired(res);
      return;
    }
    if (state.posts.size === 0) {
      fail(res, 409, 'WIDGET_NOT_READY', 'no indexed posts yet');
      return;
    }
    state.widget = { public_id: WIDGET_PUBLIC_ID, available: true, reason: 'ok' };
    ok(res, state.widget);
  }

  function handle(req, res, raw) {
    const url = new URL(req.url, 'http://127.0.0.1');
    let body = null;
    if (raw !== '') {
      try {
        body = JSON.parse(raw);
      } catch (err) {
        body = null;
      }
    }

    const authorized = req.headers.authorization === 'Bearer ' + KEY;
    const entry = {
      time: new Date().toISOString(),
      method: req.method,
      path: url.pathname,
      query: url.search,
      authorized,
      body
    };

    let answered = 200;
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (code, headers) => {
      answered = code;
      return originalWriteHead(code, headers);
    };
    res.on('finish', () => {
      entry.status = answered;
      record(entry);
    });

    if (!authorized) {
      fail(res, 401, 'UNAUTHORIZED', 'bad key');
      return;
    }
    if (url.pathname.indexOf(PREFIX) !== 0) {
      fail(res, 404, 'NOT_FOUND', 'unknown path');
      return;
    }

    const route = req.method + ' ' + url.pathname.slice(PREFIX.length);
    if (route === 'GET /status') ok(res, statusData());
    else if (route === 'GET /posts') listPosts(res, url.searchParams);
    else if (route === 'PUT /posts') putPosts(res, body);
    else if (route === 'POST /posts/delete') deletePosts(res, body);
    else if (route === 'POST /widget/enable') enableWidget(res);
    else fail(res, 404, 'NOT_FOUND', 'unknown route');
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => handle(req, res, Buffer.concat(chunks).toString('utf8')));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port || 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        url: 'http://127.0.0.1:' + port,
        state,
        requests,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (name.indexOf('--') !== 0 || i + 1 >= argv.length) {
      throw new Error('bad argument: ' + name);
    }
    out[name.slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['site-url']) {
    throw new Error('--site-url is required');
  }
  if (args.plan !== undefined && args.plan !== 'expired' && args.plan !== 'active') {
    throw new Error('--plan must be expired or active');
  }
  const mock = await startMock({
    siteUrl: args['site-url'],
    logFile: args.log,
    port: args.port ? parseInt(args.port, 10) : 0,
    putStatus: args['put-status'] ? parseInt(args['put-status'], 10) : 0,
    planExpired: args.plan === 'expired',
    seed: args.seed ? args.seed.split(',').filter((id) => id !== '') : []
  });
  if (args['port-file']) {
    fs.writeFileSync(args['port-file'], String(mock.port) + '\n');
  }
  process.stdout.write('mock connect listening on ' + mock.url + ' (site_url ' + args['site-url'] + ')\n');
  const stop = () => {
    mock.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write('mock-connect: ' + err.message + '\n');
    process.exit(1);
  });
}

module.exports = { startMock, KEY, SOURCE_ID, WIDGET_PUBLIC_ID };
