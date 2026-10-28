'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const util = require('node:util');
const { EventEmitter } = require('node:events');

const { createClient, createTransport, ConnectError, describeError } = require('../lib/client');

const KEY = 'mbk_live_0123456789abcdefSECRET';
const API = 'https://api.example.test';
const BASE = API + '/momobird/api/public/connect/v1';

function envelope(data) {
  return JSON.stringify({ code: 'OK', message: 'ok', data });
}

function ok(data) {
  return { status: 200, body: envelope(data) };
}

function failure(status, code) {
  return { status, body: JSON.stringify({ code, message: 'nope', data: null }) };
}

// A transport that replays `steps` in order and records every request. A step
// is a response object, an Error (rejects) or a function returning either.
function fakeTransport(steps) {
  const calls = [];
  const transport = (req) => {
    calls.push(req);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    const value = typeof step === 'function' ? step(req) : step;
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  };
  transport.calls = calls;
  return transport;
}

function makeClient(steps, extra) {
  const transport = fakeTransport(steps);
  const sleeps = [];
  const client = createClient(
    Object.assign(
      {
        api: API,
        key: KEY,
        transport,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        }
      },
      extra
    )
  );
  return { client, transport, sleeps };
}

async function caught(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected the call to reject');
  return null;
}

function assertNoKey(err) {
  const views = [err.message, String(err), err.stack, JSON.stringify(err), util.inspect(err, { depth: 5 })];
  views.forEach((view) => {
    assert.ok(!view.includes(KEY), 'key leaked: ' + view);
    assert.ok(!view.includes('mbk_'), 'key prefix leaked: ' + view);
  });
}

// ---------------------------------------------------------------- requests

test('status sends GET /status with auth headers and no body', async () => {
  const { client, transport } = makeClient([ok({ project: { name: 'Blog' } })]);
  const data = await client.status();

  assert.deepEqual(data, { project: { name: 'Blog' } });
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(transport.calls[0], {
    method: 'GET',
    url: BASE + '/status',
    headers: { Authorization: 'Bearer ' + KEY, Accept: 'application/json' }
  });
  assert.ok(!('body' in transport.calls[0]));
});

test('listPosts requests 500 per page and appends the cursor when given', async () => {
  const page = { items: [{ external_id: '1' }], next_cursor: null };
  const { client, transport } = makeClient([ok(page)]);

  assert.deepEqual(await client.listPosts(), page);
  assert.deepEqual(await client.listPosts(undefined), page);
  assert.deepEqual(await client.listPosts(null), page);
  assert.deepEqual(await client.listPosts(''), page);
  assert.deepEqual(await client.listPosts('c1'), page);
  await client.listPosts('a b&c=d/é');

  const urls = transport.calls.map((call) => call.url);
  assert.deepEqual(urls, [
    BASE + '/posts?limit=500',
    BASE + '/posts?limit=500',
    BASE + '/posts?limit=500',
    BASE + '/posts?limit=500',
    BASE + '/posts?limit=500&cursor=c1',
    BASE + '/posts?limit=500&cursor=' + encodeURIComponent('a b&c=d/é')
  ]);
  transport.calls.forEach((call) => {
    assert.equal(call.method, 'GET');
    assert.deepEqual(call.headers, { Authorization: 'Bearer ' + KEY, Accept: 'application/json' });
    assert.ok(!('body' in call));
  });
});

test('upsertPosts sends PUT /posts with a JSON body', async () => {
  const posts = [{ external_id: '1', title: '你好', content: '正文', url: 'https://x.test/a/' }];
  const results = { results: [{ external_id: '1', document_id: 'd1', status: 'created', error_code: null }] };
  const { client, transport } = makeClient([ok(results)]);

  assert.deepEqual(await client.upsertPosts(posts), results);
  assert.deepEqual(transport.calls[0], {
    method: 'PUT',
    url: BASE + '/posts',
    headers: {
      Authorization: 'Bearer ' + KEY,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ posts })
  });
});

test('deletePosts sends POST /posts/delete with external_ids', async () => {
  const results = { results: [{ external_id: '1', status: 'deleted' }] };
  const { client, transport } = makeClient([ok(results)]);

  assert.deepEqual(await client.deletePosts(['1', '2']), results);
  assert.deepEqual(transport.calls[0], {
    method: 'POST',
    url: BASE + '/posts/delete',
    headers: {
      Authorization: 'Bearer ' + KEY,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ external_ids: ['1', '2'] })
  });
});

test('enableWidget sends POST /widget/enable without a body', async () => {
  const widget = { available: true, public_id: 'pub_1', reason: null };
  const { client, transport } = makeClient([ok(widget)]);

  assert.deepEqual(await client.enableWidget(), widget);
  assert.deepEqual(transport.calls[0], {
    method: 'POST',
    url: BASE + '/widget/enable',
    headers: { Authorization: 'Bearer ' + KEY, Accept: 'application/json' }
  });
  assert.ok(!('body' in transport.calls[0]));
});

test('a local http api address is used as given', async () => {
  const { client, transport } = makeClient([ok({})], { api: 'http://127.0.0.1:8080' });
  await client.status();
  assert.equal(transport.calls[0].url, 'http://127.0.0.1:8080/momobird/api/public/connect/v1/status');
});

test('createClient refuses a missing key or api', () => {
  assert.throws(() => createClient({ api: API }), /key/);
  assert.throws(() => createClient({ api: API, key: '' }), /key/);
  assert.throws(() => createClient({ key: KEY }), /api/);
  assert.throws(() => createClient(), /api/);
});

// ----------------------------------------------------------------- retries

test('503, 503, 200 succeeds on the third attempt after waiting 1s then 3s', async () => {
  const { client, transport, sleeps } = makeClient([failure(503, 'UNAVAILABLE'), failure(503, 'UNAVAILABLE'), ok({ fine: true })]);

  assert.deepEqual(await client.status(), { fine: true });
  assert.equal(transport.calls.length, 3);
  assert.deepEqual(sleeps, [1000, 3000]);
});

test('503 three times gives up with an http ConnectError', async () => {
  const { client, transport, sleeps } = makeClient([failure(503, 'UNAVAILABLE')]);
  const err = await caught(client.status());

  assert.ok(err instanceof ConnectError);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'ConnectError');
  assert.equal(err.kind, 'http');
  assert.equal(err.status, 503);
  assert.equal(err.code, 'UNAVAILABLE');
  assert.equal(err.message, 'MomoBird 暂时不可用（HTTP 503）');
  assert.equal(transport.calls.length, 3);
  assert.deepEqual(sleeps, [1000, 3000]);
});

test('401 is not retried', async () => {
  const { client, transport, sleeps } = makeClient([failure(401, 'UNAUTHORIZED'), ok({})]);
  const err = await caught(client.status());

  assert.equal(err.kind, 'http');
  assert.equal(err.status, 401);
  assert.equal(err.message, '连接密钥无效或已被吊销，请在 MomoBird 控制台重新生成');
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('other 4xx answers are not retried and keep their error code', async () => {
  const cases = [
    [402, 'PLAN_REQUIRED', '套餐已到期，同步需要专业版或试用'],
    [409, 'SOURCE_DISABLED', '这个知识源已在 MomoBird 控制台停用'],
    [409, 'WIDGET_NOT_READY', '文章还在建索引，问答助手下次构建时再开启'],
    [422, 'VALIDATION_FAILED', 'MomoBird 返回错误（HTTP 422 VALIDATION_FAILED）'],
    [404, 'NOT_FOUND', 'MomoBird 返回错误（HTTP 404 NOT_FOUND）']
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const [status, code, message] = cases[i];
    const { client, transport } = makeClient([failure(status, code), ok({})]);
    const err = await caught(client.upsertPosts([]));
    assert.equal(err.kind, 'http');
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    assert.equal(err.message, message);
    assert.equal(transport.calls.length, 1, 'status ' + status + ' must not be retried');
  }
});

test('network errors are retried, then reported as kind network', async () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
  const { client, transport, sleeps } = makeClient([refused]);
  const err = await caught(client.status());

  assert.ok(err instanceof ConnectError);
  assert.equal(err.kind, 'network');
  assert.equal(err.status, undefined);
  assert.equal(err.message, '连不上 MomoBird：connect ECONNREFUSED 127.0.0.1:9');
  assert.equal(transport.calls.length, 3);
  assert.deepEqual(sleeps, [1000, 3000]);
});

test('a network error followed by a good answer succeeds', async () => {
  const { client, transport } = makeClient([new Error('socket hang up'), ok({ again: true })]);
  assert.deepEqual(await client.status(), { again: true });
  assert.equal(transport.calls.length, 2);
});

test('a network error without a message falls back to its code', async () => {
  const { client } = makeClient([Object.assign(new Error(''), { code: 'ETIMEDOUT' })], { retryDelaysMs: [] });
  const err = await caught(client.status());
  assert.equal(err.message, '连不上 MomoBird：ETIMEDOUT');
});

test('retryDelaysMs sets the number of attempts and the waits', async () => {
  const none = makeClient([failure(500, 'BOOM')], { retryDelaysMs: [] });
  await caught(none.client.status());
  assert.equal(none.transport.calls.length, 1);
  assert.deepEqual(none.sleeps, []);

  const three = makeClient([failure(500, 'BOOM')], { retryDelaysMs: [5, 6, 7] });
  await caught(three.client.status());
  assert.equal(three.transport.calls.length, 4);
  assert.deepEqual(three.sleeps, [5, 6, 7]);
});

test('the default sleep really waits between attempts', async () => {
  const transport = fakeTransport([failure(502, 'BAD_GATEWAY'), ok({ slept: true })]);
  const client = createClient({ api: API, key: KEY, transport, retryDelaysMs: [30] });
  const started = Date.now();
  assert.deepEqual(await client.status(), { slept: true });
  assert.ok(Date.now() - started >= 25);
  assert.equal(transport.calls.length, 2);
});

test('a bad transport result counts as a network error', async () => {
  const { client } = makeClient([undefined], { retryDelaysMs: [] });
  const err = await caught(client.status());
  assert.equal(err.kind, 'network');
});

// ----------------------------------------------------- malformed responses

test('a 2xx answer that is not JSON is an http error and is not retried', async () => {
  const { client, transport } = makeClient([{ status: 200, body: '<html>captive portal</html>' }]);
  const err = await caught(client.status());

  assert.equal(err.kind, 'http');
  assert.equal(err.status, 200);
  assert.equal(err.code, undefined);
  assert.equal(err.message, 'MomoBird 返回错误（HTTP 200）');
  assert.equal(transport.calls.length, 1);
});

test('a 2xx answer without data is an http error', async () => {
  const bodies = ['{}', '{"code":"OK"}', '{"code":"OK","data":null}', '[]', 'null', '"x"', ''];
  for (let i = 0; i < bodies.length; i += 1) {
    const { client, transport } = makeClient([{ status: 200, body: bodies[i] }]);
    const err = await caught(client.status());
    assert.equal(err.kind, 'http', 'body ' + JSON.stringify(bodies[i]));
    assert.equal(err.status, 200);
    assert.equal(transport.calls.length, 1);
  }
});

test('a falsy but present data value is still returned', async () => {
  const { client } = makeClient([{ status: 200, body: '{"code":"OK","data":0}' }]);
  assert.equal(await client.status(), 0);
});

test('a non-JSON 5xx page is retried and ends as an http error without a code', async () => {
  const { client, transport } = makeClient([{ status: 502, body: '<html>Bad Gateway</html>' }]);
  const err = await caught(client.status());

  assert.equal(err.kind, 'http');
  assert.equal(err.status, 502);
  assert.equal(err.code, undefined);
  assert.equal(err.message, 'MomoBird 暂时不可用（HTTP 502）');
  assert.equal(transport.calls.length, 3);
});

test('a redirect is not followed and is reported as an http error', async () => {
  const { client, transport } = makeClient([{ status: 301, body: '' }]);
  const err = await caught(client.status());
  assert.equal(err.kind, 'http');
  assert.equal(err.status, 301);
  assert.equal(err.message, 'MomoBird 返回错误（HTTP 301）');
  assert.equal(transport.calls.length, 1);
});

test('a server error code that does not look like a code is dropped', async () => {
  const { client } = makeClient([{ status: 422, body: JSON.stringify({ code: 'Bearer ' + KEY }) }]);
  const err = await caught(client.status());
  assert.equal(err.code, undefined);
  assertNoKey(err);
});

// --------------------------------------------------------- key never leaks

test('the key never shows up in any error', async () => {
  const scenarios = [
    [failure(401, 'UNAUTHORIZED')],
    [failure(402, 'PLAN_REQUIRED')],
    [failure(409, 'SOURCE_DISABLED')],
    [failure(503, 'UNAVAILABLE')],
    [{ status: 200, body: 'not json' }],
    [new Error('connect ECONNREFUSED')],
    // A transport (or Node itself) that echoes request details in its error.
    [new Error('request failed: Authorization: Bearer ' + KEY)],
    [Object.assign(new Error('bad header ' + KEY), { code: KEY })],
    [Object.assign(new Error('boom'), { config: { headers: { Authorization: 'Bearer ' + KEY } } })]
  ];
  for (let i = 0; i < scenarios.length; i += 1) {
    const { client } = makeClient(scenarios[i]);
    const err = await caught(client.listPosts('c1'));
    assert.ok(err instanceof ConnectError);
    assertNoKey(err);
  }
});

test('a transport error object is not kept on the ConnectError', async () => {
  const inner = Object.assign(new Error('boom'), { config: { headers: { Authorization: 'Bearer ' + KEY } } });
  const { client } = makeClient([inner], { retryDelaysMs: [] });
  const err = await caught(client.status());
  assert.equal(err.cause, undefined);
  assert.ok(!util.inspect(err, { depth: 10 }).includes(KEY));
});

// ----------------------------------------------------------- describeError

test('describeError covers every documented case', () => {
  const cases = [
    [{ kind: 'http', status: 401 }, '连接密钥无效或已被吊销，请在 MomoBird 控制台重新生成'],
    [{ kind: 'http', status: 401, code: 'WHATEVER' }, '连接密钥无效或已被吊销，请在 MomoBird 控制台重新生成'],
    [{ kind: 'http', status: 402, code: 'PLAN_REQUIRED' }, '套餐已到期，同步需要专业版或试用'],
    [{ kind: 'http', status: 402 }, '套餐已到期，同步需要专业版或试用'],
    [{ kind: 'http', status: 409, code: 'SOURCE_DISABLED' }, '这个知识源已在 MomoBird 控制台停用'],
    [{ kind: 'http', status: 409, code: 'WIDGET_NOT_READY' }, '文章还在建索引，问答助手下次构建时再开启'],
    [{ kind: 'http', status: 409, code: 'SOMETHING_ELSE' }, 'MomoBird 返回错误（HTTP 409 SOMETHING_ELSE）'],
    [{ kind: 'http', status: 409 }, 'MomoBird 返回错误（HTTP 409）'],
    [{ kind: 'http', status: 500 }, 'MomoBird 暂时不可用（HTTP 500）'],
    [{ kind: 'http', status: 503, code: 'UNAVAILABLE' }, 'MomoBird 暂时不可用（HTTP 503）'],
    [{ kind: 'http', status: 599 }, 'MomoBird 暂时不可用（HTTP 599）'],
    [{ kind: 'http', status: 422, code: 'VALIDATION_FAILED' }, 'MomoBird 返回错误（HTTP 422 VALIDATION_FAILED）'],
    [{ kind: 'http', status: 404 }, 'MomoBird 返回错误（HTTP 404）'],
    [{ kind: 'http', status: 200 }, 'MomoBird 返回错误（HTTP 200）'],
    [{ kind: 'network', reason: 'getaddrinfo ENOTFOUND api.example.test' }, '连不上 MomoBird：getaddrinfo ENOTFOUND api.example.test'],
    [{ kind: 'network', message: 'ECONNRESET' }, '连不上 MomoBird：ECONNRESET'],
    [{ kind: 'network' }, '连不上 MomoBird：未知错误']
  ];
  cases.forEach(([input, expected]) => {
    assert.equal(describeError(input), expected, JSON.stringify(input));
  });
});

test('describeError accepts real ConnectErrors and does not double the network prefix', () => {
  const network = new ConnectError({ kind: 'network', reason: 'socket hang up' });
  assert.equal(network.message, '连不上 MomoBird：socket hang up');
  assert.equal(describeError(network), '连不上 MomoBird：socket hang up');

  const server = new ConnectError({ kind: 'http', status: 409, code: 'SOURCE_DISABLED' });
  assert.equal(server.kind, 'http');
  assert.equal(server.status, 409);
  assert.equal(server.code, 'SOURCE_DISABLED');
  assert.equal(describeError(server), '这个知识源已在 MomoBird 控制台停用');
});

test('describeError passes other errors through', () => {
  assert.equal(describeError(new Error('plain failure')), 'plain failure');
  assert.equal(describeError('oops'), 'oops');
  assert.equal(describeError(undefined), '未知错误');
});

// ------------------------------------------------------- default transport

// Runs `handler` on a local server and hands the test an api address for it.
async function withServer(handler, run) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api = 'http://127.0.0.1:' + server.address().port;
  try {
    await run(api, server);
  } finally {
    sockets.forEach((socket) => socket.destroy());
    await new Promise((resolve) => server.close(resolve));
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

test('the default transport talks to a real http server', async () => {
  const seen = [];
  await withServer(
    async (req, res) => {
      const body = await readBody(req);
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(envelope({ echoed: true, text: '中文' }));
    },
    async (api) => {
      const client = createClient({ api, key: KEY });
      assert.deepEqual(await client.status(), { echoed: true, text: '中文' });
      assert.deepEqual(await client.upsertPosts([{ external_id: '1', title: '中文标题' }]), { echoed: true, text: '中文' });
    }
  );

  assert.equal(seen.length, 2);
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].url, '/momobird/api/public/connect/v1/status');
  assert.equal(seen[0].headers.authorization, 'Bearer ' + KEY);
  assert.equal(seen[0].headers.accept, 'application/json');
  assert.equal(seen[0].body, '');
  assert.equal(seen[1].method, 'PUT');
  assert.equal(seen[1].url, '/momobird/api/public/connect/v1/posts');
  assert.equal(seen[1].headers['content-type'], 'application/json');
  assert.equal(seen[1].body, JSON.stringify({ posts: [{ external_id: '1', title: '中文标题' }] }));
  assert.equal(Number(seen[1].headers['content-length']), Buffer.byteLength(seen[1].body));
});

test('the default transport returns non-2xx answers instead of throwing, and retries 5xx', async () => {
  let hits = 0;
  await withServer(
    (req, res) => {
      hits += 1;
      if (hits < 3) {
        res.statusCode = 503;
        res.end(JSON.stringify({ code: 'UNAVAILABLE', message: 'later', data: null }));
        return;
      }
      res.end(envelope({ hits }));
    },
    async (api) => {
      const client = createClient({ api, key: KEY, retryDelaysMs: [1, 1] });
      assert.deepEqual(await client.status(), { hits: 3 });
    }
  );

  hits = 0;
  await withServer(
    (req, res) => {
      hits += 1;
      res.statusCode = 401;
      res.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'bad key', data: null }));
    },
    async (api) => {
      const client = createClient({ api, key: KEY, retryDelaysMs: [1, 1] });
      const err = await caught(client.status());
      assert.equal(err.kind, 'http');
      assert.equal(err.status, 401);
      assert.equal(hits, 1);
    }
  );
});

test('the default transport times out a server that never answers', async () => {
  let hits = 0;
  await withServer(
    () => {
      hits += 1; // never responds
    },
    async (api) => {
      const client = createClient({ api, key: KEY, timeoutMs: 50, retryDelaysMs: [1] });
      const started = Date.now();
      const err = await caught(client.status());

      assert.ok(Date.now() - started < 5000);
      assert.equal(err.kind, 'network');
      assert.match(err.message, /^连不上 MomoBird：请求超时/);
      assert.equal(hits, 2, 'a timeout is a network error and is retried');
      assertNoKey(err);
    }
  );
});

test('the default transport times out a server that stalls halfway through the body', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"code":"OK","data":');
    },
    async (api) => {
      const client = createClient({ api, key: KEY, timeoutMs: 50, retryDelaysMs: [] });
      const err = await caught(client.status());
      assert.equal(err.kind, 'network');
      assert.match(err.message, /请求超时/);
    }
  );
});

test('the default transport aborts a response bigger than 5 MB', async () => {
  const chunk = Buffer.alloc(1024 * 1024, 'a');
  let hits = 0;
  await withServer(
    (req, res) => {
      hits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"code":"OK","data":"');
      let sent = 0;
      const pump = () => {
        while (sent < 8) {
          sent += 1;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end('"}');
      };
      pump();
    },
    async (api) => {
      const client = createClient({ api, key: KEY, retryDelaysMs: [] });
      const err = await caught(client.status());

      assert.equal(err.kind, 'network');
      assert.match(err.message, /5 MB/);
      assert.equal(hits, 1);
    }
  );
});

test('the default transport accepts a response just under the 5 MB limit', async () => {
  const text = 'b'.repeat(4 * 1024 * 1024);
  await withServer(
    (req, res) => res.end(envelope({ text })),
    async (api) => {
      const client = createClient({ api, key: KEY, retryDelaysMs: [] });
      const data = await client.status();
      assert.equal(data.text.length, text.length);
    }
  );
});

test('the default transport reports a connection that drops mid-response', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Length': '1000' });
      res.write('{"code":');
      setTimeout(() => res.socket.destroy(), 10);
    },
    async (api) => {
      const client = createClient({ api, key: KEY, retryDelaysMs: [] });
      const err = await caught(client.status());
      assert.equal(err.kind, 'network');
      assert.match(err.message, /^连不上 MomoBird：/);
    }
  );
});

test('the default transport reports a refused connection as a network error', async () => {
  let api;
  await withServer(
    () => {},
    (address) => {
      api = address;
    }
  );
  // The server is closed now, so the port refuses connections.
  const client = createClient({ api, key: KEY, retryDelaysMs: [1] });
  const err = await caught(client.status());
  assert.equal(err.kind, 'network');
  assert.match(err.message, /^连不上 MomoBird：/);
  assertNoKey(err);
});

test('the default transport does not follow a redirect with the key', async () => {
  let otherHits = 0;
  await withServer(
    (req, res) => {
      otherHits += 1;
      res.end(envelope({}));
    },
    async (otherApi) => {
      await withServer(
        (req, res) => {
          res.writeHead(302, { Location: otherApi + '/steal' });
          res.end();
        },
        async (api) => {
          const client = createClient({ api, key: KEY, retryDelaysMs: [] });
          const err = await caught(client.status());
          assert.equal(err.kind, 'http');
          assert.equal(err.status, 302);
          assert.equal(otherHits, 0);
        }
      );
    }
  );
});

// ------------------------------------- default transport, Node 14 event order

// A stand-in for the `http`/`https` modules. Each request answers with the
// next step; a step receives the fake response right after the transport has
// attached its listeners, and emits whatever events it wants.
function fakeModules(steps) {
  const requests = [];
  const impl = {
    request(target, options, onResponse) {
      const req = new EventEmitter();
      req.write = () => true;
      req.destroy = () => {};
      req.end = () => {
        const step = steps[Math.min(requests.length - 1, steps.length - 1)];
        const res = new EventEmitter();
        res.statusCode = 200;
        res.complete = false;
        setImmediate(() => {
          onResponse(res);
          step(res);
        });
      };
      requests.push({ target, options });
      return req;
    }
  };
  return { http: impl, https: impl, requests };
}

// Node 14 on a connection that drops mid-body: `aborted`, then `end` (which
// emits `close` from inside), with `complete` still false and no `error`.
function truncatedNode14(res) {
  res.emit('data', Buffer.from('{"code":"OK","data":'));
  res.emit('aborted');
  res.emit('end');
  res.emit('close');
}

function completeAnswer(data) {
  return (res) => {
    res.complete = true;
    res.emit('data', Buffer.from(envelope(data)));
    res.emit('end');
    res.emit('close');
  };
}

function clientOver(modules, extra) {
  const sleeps = [];
  const client = createClient(
    Object.assign(
      {
        api: 'http://127.0.0.1:1',
        key: KEY,
        transport: createTransport(30000, modules),
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        }
      },
      extra
    )
  );
  return { client, sleeps };
}

test('a response cut off mid-body (Node 14 event order) is a network error, not a 200', async () => {
  const modules = fakeModules([truncatedNode14]);
  const { client } = clientOver(modules, { retryDelaysMs: [] });
  const err = await caught(client.status());

  assert.ok(err instanceof ConnectError);
  assert.equal(err.kind, 'network');
  assert.equal(err.status, undefined);
  assert.equal(err.message, '连不上 MomoBird：连接在响应过程中中断');
  assert.equal(modules.requests.length, 1);
  assertNoKey(err);
});

test('a response cut off mid-body is retried and the next attempt can succeed', async () => {
  const modules = fakeModules([truncatedNode14, truncatedNode14, completeAnswer({ recovered: true })]);
  const { client, sleeps } = clientOver(modules);

  assert.deepEqual(await client.status(), { recovered: true });
  assert.equal(modules.requests.length, 3);
  assert.deepEqual(sleeps, [1000, 3000]);
});

test('a response cut off on every attempt ends as a network error after 3 attempts', async () => {
  const modules = fakeModules([truncatedNode14]);
  const { client, sleeps } = clientOver(modules);
  const err = await caught(client.status());

  assert.equal(err.kind, 'network');
  assert.equal(modules.requests.length, 3);
  assert.deepEqual(sleeps, [1000, 3000]);
});

test('a complete response through the same stand-in is accepted', async () => {
  const modules = fakeModules([completeAnswer({ fine: true })]);
  const { client } = clientOver(modules, { retryDelaysMs: [] });
  assert.deepEqual(await client.status(), { fine: true });
  assert.equal(modules.requests.length, 1);
});

test('a response that closes without ever ending is a network error too', async () => {
  const modules = fakeModules([
    (res) => {
      res.emit('data', Buffer.from('{"code":"OK"'));
      res.emit('aborted');
      res.emit('close');
    }
  ]);
  const { client } = clientOver(modules, { retryDelaysMs: [] });
  const err = await caught(client.status());
  assert.equal(err.kind, 'network');
  assert.equal(err.message, '连不上 MomoBird：连接在响应过程中中断');
});
