'use strict';

const crypto = require('crypto');

// A stable numeric id for a post, derived from its source file path
// (for example "_posts/hello-world.md"). MomoBird's public podcast API and the
// player only accept numeric post ids, so the id is the first 52 bits of the
// path's SHA-256 written in decimal: at most 16 digits, inside the safe-integer
// range.
function externalId(source) {
  const path = String(source).replace(/\\/g, '/').normalize('NFC');
  const hex = crypto.createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 13);
  return BigInt('0x' + hex).toString(10);
}

module.exports = { externalId };
