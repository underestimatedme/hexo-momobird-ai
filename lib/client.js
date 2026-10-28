'use strict';

const http = require('http');
const https = require('https');

const API_PREFIX = '/momobird/api/public/connect/v1';
const PAGE_SIZE = 500;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_REASON_LENGTH = 200;
const TRUNCATED_MESSAGE = '连接在响应过程中中断';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RETRY_DELAYS_MS = [1000, 3000];

// Error codes are short upper-case identifiers. Anything else the server
// sends back in `code` is ignored rather than copied into a message.
const CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

// Turns a ConnectError-like object into the sentence the blogger sees. It is
// pure: no key, header or response body ever goes through here.
function describeError(err) {
  if (err === null || err === undefined) return '未知错误';
  if (typeof err === 'string') return err;

  if (err.kind === 'http') {
    const status = err.status;
    if (status === 401) return '连接密钥无效或已被吊销，请在 MomoBird 控制台重新生成';
    if (status === 402) return '套餐已到期，同步需要专业版或试用';
    if (status === 409 && err.code === 'SOURCE_DISABLED') return '这个知识源已在 MomoBird 控制台停用';
    if (status === 409 && err.code === 'WIDGET_NOT_READY') return '文章还在建索引，问答助手下次构建时再开启';
    if (status >= 500) return 'MomoBird 暂时不可用（HTTP ' + status + '）';
    return 'MomoBird 返回错误（HTTP ' + status + (err.code ? ' ' + err.code : '') + '）';
  }

  if (err.kind === 'network') {
    return '连不上 MomoBird：' + (err.reason || err.message || '未知错误');
  }

  return err.message ? String(err.message) : String(err);
}

class ConnectError extends Error {
  // `reason` is only meaningful for network errors; the caller has already
  // removed the key from it.
  constructor(details) {
    const info = details || {};
    const fields = {
      kind: info.kind === 'network' ? 'network' : 'http',
      status: info.status,
      code: info.code,
      reason: info.kind === 'network' ? info.reason || '未知错误' : undefined
    };
    super(describeError(fields));
    this.name = 'ConnectError';
    this.kind = fields.kind;
    if (fields.status !== undefined) this.status = fields.status;
    if (fields.code !== undefined) this.code = fields.code;
    if (fields.reason !== undefined) this.reason = fields.reason;
  }
}

// Removes the key (and anything shaped like one) from text that came from
// outside, so it can never end up in a message, a stack or a log line.
function redact(text, key) {
  let clean = String(text);
  if (key) clean = clean.split(key).join('***');
  return clean.replace(/mbk_[A-Za-z0-9_-]*/g, '***');
}

function reasonOf(err, key) {
  let text = '';
  if (typeof err === 'string') text = err;
  else if (err && typeof err.message === 'string' && err.message !== '') text = err.message;
  else if (err && typeof err.code === 'string') text = err.code;

  text = redact(text.replace(/\s+/g, ' ').trim(), key);
  if (text.length > MAX_REASON_LENGTH) text = text.slice(0, MAX_REASON_LENGTH) + '…';
  return text || '未知错误';
}

function parseEnvelope(body) {
  try {
    const value = JSON.parse(body);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (err) {
    return null;
  }
}

function seconds(ms) {
  return String(Math.round((ms / 1000) * 1000) / 1000);
}

// The default transport. It sends one request and resolves with the status
// and body whatever the status is; only failures to get an answer reject.
// `timeoutMs` bounds the whole exchange, so a server that trickles bytes
// cannot hold the build forever. Redirects are not followed, so the key is
// never sent to a host other than the configured one.
function createTransport(timeoutMs, modules) {
  const protocols = modules || { http, https };
  return function transport(req) {
    return new Promise((resolve, reject) => {
      const target = new URL(req.url);
      const lib = target.protocol === 'http:' ? protocols.http : protocols.https;
      const headers = Object.assign({}, req.headers);
      const payload = req.body === undefined ? null : Buffer.from(String(req.body), 'utf8');
      if (payload) headers['Content-Length'] = String(payload.length);

      let settled = false;
      let timer = null;
      let request = null;

      function settle(fn, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      }

      function abort(error) {
        settle(reject, error);
        if (request) request.destroy();
      }

      request = lib.request(target, { method: req.method, headers }, (res) => {
        const chunks = [];
        let size = 0;

        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            abort(new Error('响应体超过 5 MB'));
            return;
          }
          chunks.push(chunk);
        });
        // Node 14 emits `end` (and then `close`) for a response that was cut
        // off, with `complete` still false; later versions emit `error`. Either
        // way a partial body must never be taken for an answer.
        res.on('end', () => {
          if (!res.complete) {
            settle(reject, new Error(TRUNCATED_MESSAGE));
            return;
          }
          settle(resolve, { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', (err) => settle(reject, err));
        res.on('close', () => {
          if (!res.complete) settle(reject, new Error(TRUNCATED_MESSAGE));
        });
      });

      timer = setTimeout(() => abort(new Error('请求超时（' + seconds(timeoutMs) + ' 秒）')), timeoutMs);
      request.on('error', (err) => settle(reject, err));
      if (payload) request.write(payload);
      request.end();
    });
  };
}

function sleepFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createClient(options) {
  const opts = options || {};
  if (typeof opts.api !== 'string' || opts.api === '') {
    throw new TypeError('createClient 需要 api 地址');
  }
  if (typeof opts.key !== 'string' || opts.key === '') {
    throw new TypeError('createClient 需要 key（连接密钥）');
  }

  const key = opts.key;
  const base = opts.api + API_PREFIX;
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs;
  const delays = Array.isArray(opts.retryDelaysMs) ? opts.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
  const transport = typeof opts.transport === 'function' ? opts.transport : createTransport(timeoutMs);
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : sleepFor;

  function networkError(err) {
    return new ConnectError({ kind: 'network', reason: reasonOf(err, key) });
  }

  // Maps one transport result to { data } or { error }.
  function interpret(res) {
    if (res === null || typeof res !== 'object' || typeof res.status !== 'number' || typeof res.body !== 'string') {
      return { error: networkError('传输层返回了无效的响应') };
    }

    const envelope = parseEnvelope(res.body);
    if (res.status >= 200 && res.status < 300) {
      if (envelope && envelope.data !== undefined && envelope.data !== null) return { data: envelope.data };
      return { error: new ConnectError({ kind: 'http', status: res.status }) };
    }

    let code;
    if (envelope && typeof envelope.code === 'string' && CODE_PATTERN.test(envelope.code)) {
      if (redact(envelope.code, key) === envelope.code) code = envelope.code;
    }
    return { error: new ConnectError({ kind: 'http', status: res.status, code }) };
  }

  function retryable(error) {
    return error.kind === 'network' || (error.kind === 'http' && error.status >= 500);
  }

  async function perform(method, path, payload) {
    const req = {
      method,
      url: base + path,
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }
    };
    if (payload !== undefined) {
      req.headers['Content-Type'] = 'application/json';
      req.body = JSON.stringify(payload);
    }

    for (let attempt = 0; ; attempt += 1) {
      let outcome;
      try {
        outcome = interpret(await transport(req));
      } catch (err) {
        outcome = { error: networkError(err) };
      }

      if (outcome.error === undefined) return outcome.data;
      if (!retryable(outcome.error) || attempt >= delays.length) throw outcome.error;
      await sleep(delays[attempt]);
    }
  }

  return {
    status() {
      return perform('GET', '/status');
    },
    listPosts(cursor) {
      let path = '/posts?limit=' + PAGE_SIZE;
      if (cursor) path += '&cursor=' + encodeURIComponent(cursor);
      return perform('GET', path);
    },
    upsertPosts(posts) {
      return perform('PUT', '/posts', { posts });
    },
    deletePosts(ids) {
      return perform('POST', '/posts/delete', { external_ids: ids });
    },
    enableWidget() {
      return perform('POST', '/widget/enable');
    }
  };
}

module.exports = { createClient, createTransport, ConnectError, describeError };
