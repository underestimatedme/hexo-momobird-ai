'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readConfig, ConfigError } = require('../lib/config');

const KEY_MESSAGE = '连接密钥不能写在 _config.yml 里，请删掉它并改用环境变量 MOMOBIRD_KEY';

const DEFAULTS = {
  key: null,
  api: 'https://api.valley.atlaspaces.com',
  sync: true,
  widget: false,
  widgetPosition: 'right',
  podcast: true,
  podcastTranscript: false,
  strict: false
};

test('readConfig returns the full set of defaults', () => {
  assert.deepEqual(readConfig({}, {}), DEFAULTS);
});

test('readConfig tolerates a missing momobird section, site config and env', () => {
  assert.deepEqual(readConfig({ title: 'My blog' }, {}), DEFAULTS);
  assert.deepEqual(readConfig({ momobird: null }, {}), DEFAULTS);
  assert.deepEqual(readConfig({ momobird: {} }, {}), DEFAULTS);
  assert.deepEqual(readConfig(undefined, undefined), DEFAULTS);
  assert.deepEqual(readConfig(null, null), DEFAULTS);
});

test('readConfig ignores a momobird section that is not a mapping', () => {
  assert.deepEqual(readConfig({ momobird: true }, {}), DEFAULTS);
  assert.deepEqual(readConfig({ momobird: 'on' }, {}), DEFAULTS);
  assert.deepEqual(readConfig({ momobird: ['sync'] }, {}), DEFAULTS);
});

test('readConfig maps every option from the momobird section', () => {
  const config = readConfig(
    {
      momobird: {
        sync: false,
        widget: true,
        widget_position: 'left',
        podcast: false,
        podcast_transcript: true,
        strict: true,
        api: 'https://example.org'
      }
    },
    {}
  );
  assert.deepEqual(config, {
    key: null,
    api: 'https://example.org',
    sync: false,
    widget: true,
    widgetPosition: 'left',
    podcast: false,
    podcastTranscript: true,
    strict: true
  });
});

test('readConfig keeps the default for anything that is not a boolean', () => {
  const config = readConfig(
    {
      momobird: {
        sync: 'false',
        widget: 'true',
        podcast: 0,
        podcast_transcript: 'yes',
        strict: 1
      }
    },
    {}
  );
  assert.equal(config.sync, true);
  assert.equal(config.widget, false);
  assert.equal(config.podcast, true);
  assert.equal(config.podcastTranscript, false);
  assert.equal(config.strict, false);
});

test('readConfig falls back to the right side for an unknown widget_position', () => {
  for (const value of ['top', '', 'LEFT', 7, null, true, undefined]) {
    assert.equal(
      readConfig({ momobird: { widget_position: value } }, {}).widgetPosition,
      'right',
      JSON.stringify(value)
    );
  }
  assert.equal(readConfig({ momobird: { widget_position: 'right' } }, {}).widgetPosition, 'right');
  assert.equal(readConfig({ momobird: { widget_position: 'left' } }, {}).widgetPosition, 'left');
});

test('readConfig takes the key from MOMOBIRD_KEY only, trimmed', () => {
  assert.equal(readConfig({}, { MOMOBIRD_KEY: 'mbk_secret_value' }).key, 'mbk_secret_value');
  assert.equal(readConfig({}, { MOMOBIRD_KEY: '  mbk_secret_value \n' }).key, 'mbk_secret_value');
  assert.equal(readConfig({}, { OTHER: 'mbk_secret_value' }).key, null);
});

test('readConfig treats a blank MOMOBIRD_KEY as no key', () => {
  assert.equal(readConfig({}, { MOMOBIRD_KEY: '  ' }).key, null);
  assert.equal(readConfig({}, { MOMOBIRD_KEY: '' }).key, null);
  assert.equal(readConfig({}, { MOMOBIRD_KEY: '\t\n' }).key, null);
  assert.equal(readConfig({}, { MOMOBIRD_KEY: undefined }).key, null);
  assert.equal(readConfig({}, { MOMOBIRD_KEY: 12345 }).key, null);
});

test('readConfig does not mutate the site config', () => {
  const site = { momobird: { widget: true, widget_position: 'left', api: 'https://example.org/' } };
  const copy = JSON.parse(JSON.stringify(site));
  readConfig(site, { MOMOBIRD_KEY: 'mbk_x' });
  assert.deepEqual(site, copy);
});

test('a key field in the momobird section is refused without echoing it', () => {
  assert.throws(
    () => readConfig({ momobird: { key: 'x' } }, {}),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'ConfigError');
      assert.equal(err.message, KEY_MESSAGE);
      assert.ok(!err.message.includes('x'));
      return true;
    }
  );
});

test('a secret field in the momobird section is refused', () => {
  assert.throws(
    () => readConfig({ momobird: { secret: 'hunter2' } }, {}),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.message, KEY_MESSAGE);
      assert.ok(!err.message.includes('hunter2'));
      return true;
    }
  );
});

test('a key or secret field is refused whatever its value', () => {
  for (const value of ['', null, 0, false, {}]) {
    assert.throws(() => readConfig({ momobird: { key: value } }, {}), ConfigError);
    assert.throws(() => readConfig({ momobird: { secret: value } }, {}), ConfigError);
  }
});

test('any string value starting with mbk_ is refused without echoing it', () => {
  assert.throws(
    () => readConfig({ momobird: { widget: true, note: 'mbk_abc' } }, {}),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.message, KEY_MESSAGE);
      assert.ok(!err.message.includes('mbk_abc'));
      assert.ok(!err.message.includes('abc'));
      return true;
    }
  );
});

test('a leaked key is found in nested objects and arrays', () => {
  const nested = [
    { momobird: { extra: { deeper: { token: 'mbk_deep_value' } } } },
    { momobird: { list: ['fine', 'mbk_in_array'] } },
    { momobird: { list: [{ a: [{ b: 'mbk_very_deep' }] }] } },
    { momobird: { note: '  mbk_after_spaces' } },
    { momobird: 'mbk_whole_section' }
  ];
  for (const site of nested) {
    assert.throws(
      () => readConfig(site, {}),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.message, KEY_MESSAGE);
        assert.ok(!/deep|array|spaces|section/.test(err.message));
        return true;
      },
      JSON.stringify(site)
    );
  }
});

test('mbk_ only matters at the start of a string value', () => {
  const config = readConfig({ momobird: { note: 'about mbk_ keys', other: 'not_mbk_abc' } }, {});
  assert.deepEqual(config, DEFAULTS);
});

test('a leaked key inside the api value is refused as a key, not as a bad api', () => {
  assert.throws(
    () => readConfig({ momobird: { api: 'mbk_oops' } }, {}),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.message, KEY_MESSAGE);
      assert.ok(!err.message.includes('oops'));
      return true;
    }
  );
});

test('a key in the site config outside momobird is not this plugin\'s business', () => {
  assert.deepEqual(readConfig({ key: 'x', secret: 'y', other: { note: 'mbk_abc' } }, {}), DEFAULTS);
});

test('api over plain http to a remote host is refused', () => {
  assert.throws(
    () => readConfig({ momobird: { api: 'http://api.example.com' } }, {}),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(!err.message.includes('api.example.com'));
      return true;
    }
  );
});

test('api must use https, except plain http to localhost or 127.0.0.1', () => {
  const refused = [
    'http://api.example.com',
    'http://localhost.evil.com',
    'http://127.0.0.1.evil.com',
    'http://127.0.0.2',
    'http://0.0.0.0:8787',
    'http://[::1]:8787',
    'http://localhost@evil.com',
    'ftp://api.example.com',
    'ws://localhost',
    'api.example.com',
    '//api.example.com',
    'not a url',
    'https://'
  ];
  for (const api of refused) {
    assert.throws(() => readConfig({ momobird: { api } }, {}), ConfigError, api);
  }
});

test('api accepts https and local http, dropping the trailing slash', () => {
  const cases = [
    ['https://api.example.com', 'https://api.example.com'],
    ['https://api.example.com/', 'https://api.example.com'],
    ['https://api.example.com:8443/', 'https://api.example.com:8443'],
    ['https://API.Example.com', 'https://api.example.com'],
    ['  https://api.example.com/  ', 'https://api.example.com'],
    ['http://localhost', 'http://localhost'],
    ['http://localhost:8787', 'http://localhost:8787'],
    ['http://127.0.0.1', 'http://127.0.0.1'],
    ['http://127.0.0.1:8787/', 'http://127.0.0.1:8787'],
    ['https://localhost:8787', 'https://localhost:8787']
  ];
  for (const [api, expected] of cases) {
    assert.equal(readConfig({ momobird: { api } }, {}).api, expected, api);
  }
});

test('api with a path, credentials, query or fragment is refused', () => {
  const refused = [
    'https://api.example.com/v1',
    'https://api.example.com/v1/',
    'https://api.example.com//',
    'https://user:pass@api.example.com',
    'https://user@api.example.com',
    'https://api.example.com?x=1',
    'https://api.example.com/?x=1',
    'https://api.example.com?',
    'https://api.example.com#top',
    'https://api.example.com/#',
    'https://api.example.com\\',
    'https://api.example.com/ x'
  ];
  for (const api of refused) {
    assert.throws(
      () => readConfig({ momobird: { api } }, {}),
      (err) => {
        assert.ok(err instanceof ConfigError, api);
        assert.ok(!err.message.includes('pass'), api);
        assert.ok(!err.message.includes('api.example.com'), api);
        return true;
      },
      api
    );
  }
});

test('a blank api uses the default, anything else that is not a string is refused', () => {
  for (const api of [undefined, null, '', '   ']) {
    assert.equal(readConfig({ momobird: { api } }, {}).api, DEFAULTS.api, JSON.stringify(api));
  }
  for (const api of [42, true, ['https://api.example.com'], { url: 'https://api.example.com' }]) {
    assert.throws(() => readConfig({ momobird: { api } }, {}), ConfigError, JSON.stringify(api));
  }
});

test('the key check runs before the api check', () => {
  assert.throws(
    () => readConfig({ momobird: { key: 'x', api: 'http://api.example.com' } }, {}),
    (err) => err.message === KEY_MESSAGE
  );
});

test('a cyclic momobird section does not hang the key scan', () => {
  const section = { widget: true };
  section.self = section;
  assert.deepEqual(readConfig({ momobird: section }, {}), Object.assign({}, DEFAULTS, { widget: true }));
});
