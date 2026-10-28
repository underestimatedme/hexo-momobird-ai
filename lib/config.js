'use strict';

const DEFAULT_API = 'https://api.valley.atlaspaces.com';

const KEY_IN_CONFIG_MESSAGE = '连接密钥不能写在 _config.yml 里，请删掉它并改用环境变量 MOMOBIRD_KEY';
const API_MESSAGE =
  'api 地址不合法：必须是 HTTPS 地址（本地联调可以用 http://localhost 或 http://127.0.0.1），' +
  '并且不能带路径、账号、查询参数或锚点';

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function has(object, name) {
  return Object.prototype.hasOwnProperty.call(object, name);
}

function boolOption(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

// True when any string anywhere inside `value` looks like a MomoBird
// connection key. `seen` stops a self-referencing YAML anchor from looping.
function containsKey(value, seen) {
  if (typeof value === 'string') return /^\s*mbk_/.test(value);
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.keys(value).map((name) => value[name]);
  for (let i = 0; i < children.length; i += 1) {
    if (containsKey(children[i], seen)) return true;
  }
  return false;
}

// Returns the api address without a trailing slash. The error message never
// repeats the configured value (it could carry credentials).
function normalizeApi(value) {
  if (value === undefined || value === null) return DEFAULT_API;
  if (typeof value !== 'string') throw new ConfigError(API_MESSAGE);
  const raw = value.trim();
  if (raw === '') return DEFAULT_API;
  if (/[\s\\?#@]/.test(raw)) throw new ConfigError(API_MESSAGE);

  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    throw new ConfigError(API_MESSAGE);
  }

  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const schemeOk = url.protocol === 'https:' || (url.protocol === 'http:' && local);
  if (!schemeOk || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new ConfigError(API_MESSAGE);
  }
  return url.protocol + '//' + url.host;
}

function readConfig(siteConfig, env) {
  const section = siteConfig ? siteConfig.momobird : undefined;

  if (containsKey(section, new Set())) throw new ConfigError(KEY_IN_CONFIG_MESSAGE);
  if (isPlainObject(section) && (has(section, 'key') || has(section, 'secret'))) {
    throw new ConfigError(KEY_IN_CONFIG_MESSAGE);
  }

  const options = isPlainObject(section) ? section : {};
  const rawKey = env && typeof env.MOMOBIRD_KEY === 'string' ? env.MOMOBIRD_KEY.trim() : '';

  return {
    key: rawKey === '' ? null : rawKey,
    api: normalizeApi(options.api),
    sync: boolOption(options.sync, true),
    widget: boolOption(options.widget, false),
    widgetPosition: options.widget_position === 'left' ? 'left' : 'right',
    podcast: boolOption(options.podcast, true),
    podcastTranscript: boolOption(options.podcast_transcript, false),
    strict: boolOption(options.strict, false)
  };
}

module.exports = { readConfig, ConfigError, DEFAULT_API };
