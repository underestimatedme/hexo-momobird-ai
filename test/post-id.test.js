'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { externalId } = require('../lib/post-id');

test('externalId matches the known vectors', () => {
  assert.equal(externalId('_posts/hello-world.md'), '2771473582013371');
  assert.equal(externalId('_posts/中文 文章.md'), '3673941822749037');
});

test('externalId treats backslashes as forward slashes', () => {
  assert.equal(externalId('_posts\\a\\b.md'), '3429000370032694');
  assert.equal(externalId('_posts/a/b.md'), '3429000370032694');
  assert.equal(externalId('_posts\\a\\b.md'), externalId('_posts/a/b.md'));
});

test('externalId is always 1 to 16 decimal digits', () => {
  const inputs = [
    '',
    'a',
    '_posts/hello-world.md',
    '_posts/中文 文章.md',
    '_posts/2026/10/very/deep/path/with-a-long-name-that-goes-on-and-on.md',
    '_posts\\windows\\style.md',
    '🚀.md'
  ];
  for (const input of inputs) {
    assert.match(externalId(input), /^[0-9]{1,16}$/, JSON.stringify(input));
  }
});

test('externalId is the same for NFC and NFD spellings of one file name', () => {
  const nfc = '_posts/café.md';
  const nfd = '_posts/café.md';
  assert.notEqual(nfc, nfd);
  assert.equal(externalId(nfd), externalId(nfc));

  const hangulNfc = '_posts/한글.md';
  const hangulNfd = hangulNfc.normalize('NFD');
  assert.notEqual(hangulNfc, hangulNfd);
  assert.equal(externalId(hangulNfd), externalId(hangulNfc));
});
