'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { autoRunEnabled } = require('../lib/command');

const aliases = { g: 'generate', d: 'deploy', s: 'server' };

function run(cmd, args) {
  return autoRunEnabled({ cmd, args: args || {}, aliases });
}

test('generate and deploy run automatically, by full name or alias', () => {
  assert.equal(run('g'), true);
  assert.equal(run('generate'), true);
  assert.equal(run('d'), true);
  assert.equal(run('deploy'), true);
});

test('server, other commands and an empty command do not', () => {
  assert.equal(run('s'), false);
  assert.equal(run('server'), false);
  assert.equal(run('clean'), false);
  assert.equal(run('momobird'), false);
  assert.equal(run(''), false);
  assert.equal(run(undefined), false);
});

test('watch mode switches it off, short flag or long', () => {
  assert.equal(run('g', { w: true }), false);
  assert.equal(run('generate', { watch: true }), false);
  assert.equal(run('d', { w: true }), false);
  assert.equal(run('deploy', { watch: true }), false);
  assert.equal(run('g', { w: true, watch: true }), false);
});

test('falsy watch flags and unrelated flags leave it on', () => {
  assert.equal(run('g', { w: false }), true);
  assert.equal(run('g', { watch: false, d: true, deploy: true }), true);
  assert.equal(run('generate', { w: undefined, watch: undefined }), true);
  assert.equal(run('g', { _: [] }), true);
});

test('a missing args object or alias map is tolerated', () => {
  assert.equal(autoRunEnabled({ cmd: 'generate' }), true);
  assert.equal(autoRunEnabled({ cmd: 'generate', args: null, aliases: null }), true);
  assert.equal(autoRunEnabled({ cmd: 'g' }), false);
  assert.equal(autoRunEnabled({ cmd: 'g', aliases: {} }), false);
  assert.equal(autoRunEnabled({}), false);
  assert.equal(autoRunEnabled(), false);
});

test('alias lookup ignores inherited object properties', () => {
  assert.equal(run('constructor'), false);
  assert.equal(run('__proto__'), false);
  assert.equal(run('toString'), false);
});

test('an alias can point at a command that does not run automatically', () => {
  assert.equal(autoRunEnabled({ cmd: 'x', args: {}, aliases: { x: 'server' } }), false);
  assert.equal(autoRunEnabled({ cmd: 'x', args: {}, aliases: { x: 'generate' } }), true);
});
