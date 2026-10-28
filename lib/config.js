'use strict';

const DEFAULT_API = 'https://api.valley.atlaspaces.com';

// A key that reached _config.yml has usually been committed with it, and a
// public blog repository makes it everyone's key, so the error also says to
// replace it.
const KEY_IN_CONFIG_MESSAGE =
  '连接密钥不能写在 _config.yml 里，请删掉它并改用环境变量 MOMOBIRD_KEY。' +
  '已提交到仓库的密钥请在 MomoBird 控制台重新生成';
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

const TRUE_WORDS = ['true', 'yes', 'on', '1'];
const FALSE_WORDS = ['false', 'no', 'off', '0'];
const MAX_SHOWN_CHARS = 40;

// Hexo reads _config.yml with js-yaml (YAML 1.2), so `sync: off` and
// `sync: no` arrive as the strings "off" and "no", and `sync: 1` as a number.
// Returns true or false for a recognised value, undefined for anything else.
function booleanOf(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value !== 'string') return undefined;
  const word = value.trim().toLowerCase();
  if (TRUE_WORDS.indexOf(word) !== -1) return true;
  if (FALSE_WORDS.indexOf(word) !== -1) return false;
  return undefined;
}

// The value as it can be shown in a warning. It is never a key: a value that
// looks like one has already stopped readConfig with KEY_IN_CONFIG_MESSAGE.
function shownValue(value) {
  if (Array.isArray(value)) return '一个列表';
  if (value !== null && typeof value === 'object') return '一个对象';
  const text = typeof value === 'string' ? JSON.stringify(value) : String(value);
  return text.length > MAX_SHOWN_CHARS ? text.slice(0, MAX_SHOWN_CHARS) + '…' : text;
}

function unrecognised(name, value, consequence) {
  return (
    '配置项 ' + name + ' 的值 ' + shownValue(value) + ' 无法识别，' + consequence +
    '（可以写 true/false、yes/no、on/off 或 1/0）'
  );
}

// An empty option (absent, or `sync:` with nothing after it) is the default
// without a word; an unrecognised one is the default with a warning.
function boolOption(options, name, fallback, warn) {
  const value = options[name];
  if (value === undefined || value === null) return fallback;
  const parsed = booleanOf(value);
  if (parsed !== undefined) return parsed;
  warn(unrecognised('momobird.' + name, value, '已按默认值 ' + fallback + ' 处理'));
  return fallback;
}

// The momobird section as options. `momobird: false` (or no / off / 0) turns
// the plugin's sync, widget and podcast off; `momobird: true` and an empty
// section keep the defaults.
function sectionOptions(section, warn) {
  if (isPlainObject(section)) return section;
  if (section === undefined || section === null) return {};
  const parsed = booleanOf(section);
  if (parsed === false) return { sync: false, widget: false, podcast: false };
  if (parsed === undefined) warn(unrecognised('momobird', section, '已按默认配置处理'));
  return {};
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

// `warn(text)` receives one Chinese sentence per option whose value is not
// understood; such an option keeps its default.
function readConfig(siteConfig, env, warn) {
  const section = siteConfig ? siteConfig.momobird : undefined;
  const report = typeof warn === 'function' ? warn : () => {};

  if (containsKey(section, new Set())) throw new ConfigError(KEY_IN_CONFIG_MESSAGE);
  if (isPlainObject(section) && (has(section, 'key') || has(section, 'secret'))) {
    throw new ConfigError(KEY_IN_CONFIG_MESSAGE);
  }

  const options = sectionOptions(section, report);
  const rawKey = env && typeof env.MOMOBIRD_KEY === 'string' ? env.MOMOBIRD_KEY.trim() : '';

  return {
    key: rawKey === '' ? null : rawKey,
    api: normalizeApi(options.api),
    sync: boolOption(options, 'sync', true, report),
    widget: boolOption(options, 'widget', false, report),
    widgetPosition: options.widget_position === 'left' ? 'left' : 'right',
    podcast: boolOption(options, 'podcast', true, report),
    podcastTranscript: boolOption(options, 'podcast_transcript', false, report),
    strict: boolOption(options, 'strict', false, report)
  };
}

module.exports = { readConfig, booleanOf, ConfigError, DEFAULT_API };
