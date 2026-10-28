'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cachePath, readCache, writeCache } = require('../lib/cache');

const dirs = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexo-momobird-cache-'));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) {
    fs.rmSync ? fs.rmSync(dir, { recursive: true, force: true }) : fs.rmdirSync(dir, { recursive: true });
  }
});

test('cachePath keeps the cache under node_modules/.cache, one file per source', () => {
  assert.equal(
    cachePath('/site', '7d1f0c9e-0000-4000-8000-000000000001'),
    path.join('/site', 'node_modules', '.cache', 'hexo-momobird-ai', '7d1f0c9e-0000-4000-8000-000000000001.json')
  );
});

test('readCache returns {} when the file does not exist', () => {
  assert.deepEqual(readCache(path.join(tmpDir(), 'missing.json')), {});
});

test('readCache returns {} for a corrupt JSON file', () => {
  const file = path.join(tmpDir(), 'cache.json');
  fs.writeFileSync(file, '{"a": "1", "b":');
  assert.deepEqual(readCache(file), {});
});

test('readCache returns {} when the JSON is not an object', () => {
  const dir = tmpDir();
  for (const text of ['[]', 'null', '"abc"', '42', '', '["a"]']) {
    const file = path.join(dir, 'cache.json');
    fs.writeFileSync(file, text);
    assert.deepEqual(readCache(file), {}, 'content: ' + JSON.stringify(text));
  }
});

test('readCache keeps string digests and drops everything else', () => {
  const file = path.join(tmpDir(), 'cache.json');
  fs.writeFileSync(file, '{"a":"d1","b":2,"c":null,"d":{"x":1},"e":"d5","__proto__":"d6"}');
  const cache = readCache(file);
  assert.deepEqual(cache, { a: 'd1', e: 'd5' });
  assert.equal(Object.getPrototypeOf(cache), Object.prototype);
});

test('writeCache creates missing directories and round-trips', () => {
  const file = path.join(tmpDir(), 'node_modules', '.cache', 'hexo-momobird-ai', 'src.json');
  writeCache(file, { a: 'd1', b: 'd2' });
  assert.deepEqual(readCache(file), { a: 'd1', b: 'd2' });
});

test('writeCache replaces the old file and leaves no temporary file behind', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'src.json');
  writeCache(file, { a: 'd1' });
  writeCache(file, { b: 'd2' });
  assert.deepEqual(readCache(file), { b: 'd2' });
  assert.deepEqual(fs.readdirSync(dir), ['src.json']);
});

test('writeCache keeps the old file when the new content cannot be written', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'src.json');
  writeCache(file, { a: 'd1' });
  assert.throws(() => writeCache(file, { a: BigInt(1) }));
  assert.deepEqual(readCache(file), { a: 'd1' });
  assert.deepEqual(fs.readdirSync(dir), ['src.json']);
});

test('writeCache cleans up its temporary file when the rename fails', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'src.json');
  // A directory cannot be replaced by a file, so the rename must fail.
  fs.mkdirSync(file);
  assert.throws(() => writeCache(file, { a: 'd1' }));
  assert.deepEqual(fs.readdirSync(dir), ['src.json']);
});
