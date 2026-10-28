'use strict';

// The local record of which digest of each post MomoBird last accepted. It
// lives under node_modules/.cache, so it survives `hexo clean` and is simply
// absent on a fresh CI checkout. Losing it only costs a full re-push, which
// the server answers with `unchanged`.

const fs = require('fs');
const path = require('path');

function cachePath(baseDir, sourceId) {
  return path.join(baseDir, 'node_modules', '.cache', 'hexo-momobird-ai', sourceId + '.json');
}

// A missing, unreadable or corrupt file is an empty cache. Only entries that
// map an id to a string digest are kept; `__proto__` is skipped so the result
// can never carry anything but plain own properties.
function readCache(file) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return {};
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const cache = {};
  for (const id of Object.keys(value)) {
    if (id !== '__proto__' && typeof value[id] === 'string') {
      cache[id] = value[id];
    }
  }
  return cache;
}

// Writes next to the target and renames, so an interrupted build can leave a
// stale cache but never a half-written one.
function writeCache(file, map) {
  const text = JSON.stringify(map);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  const temp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + Date.now() + '.tmp');
  try {
    fs.writeFileSync(temp, text, 'utf8');
    fs.renameSync(temp, file);
  } catch (err) {
    try {
      fs.unlinkSync(temp);
    } catch (ignored) {
      // The temporary file was never created, or is already gone.
    }
    throw err;
  }
}

module.exports = { cachePath, readCache, writeCache };
