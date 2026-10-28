#!/usr/bin/env node
'use strict';

// Small tools for scripts/integration.sh. Kept out of the shell script so the
// parts that need real parsing (JSON Lines, process groups, Hexo's own model)
// are ordinary, readable JavaScript. Not part of the published package.
//
//   free-port                         print a free TCP port on 127.0.0.1
//   external-id <source>              print the plugin's id for a post source path
//   requests                          stdin: mock log (JSON Lines) -> one summary line per request
//   pushed                            stdin: mock log -> "id<TAB>title<TAB>category" per pushed post
//   pushed-content <external_id>      stdin: mock log -> content of the last push of that post
//   deleted                           stdin: mock log -> one deleted id per line
//   log-lint <file...>                every line with Chinese text must carry [MomoBird]; no U+FFFD
//   hexo-categories <site-dir>        load the site with its own Hexo; print each post's categories:
//                                     source<TAB>post.categories order<TAB>join-table order
//   run (--stop-after S | --limit S) -- <cmd> [args...]
//                                     run a command in its own process group; --stop-after ends it
//                                     after S seconds and exits 0, --limit exits 124 if it is still
//                                     running after S seconds

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const PREFIX = '/momobird/api/public/connect/v1';

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function readLog(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function shortPath(entry) {
  const p = entry.path.indexOf(PREFIX) === 0 ? entry.path.slice(PREFIX.length) : entry.path;
  return p + (entry.query || '');
}

function bodyPosts(entry) {
  return entry.method === 'PUT' && entry.body && Array.isArray(entry.body.posts) ? entry.body.posts : [];
}

function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => process.stdout.write(port + '\n'));
  });
}

function requests() {
  for (const entry of readLog(readStdin())) {
    let detail = '';
    if (entry.method === 'PUT') detail = ' posts=' + bodyPosts(entry).length;
    if (entry.path.slice(-13) === '/posts/delete') {
      detail = ' ids=' + (entry.body && Array.isArray(entry.body.external_ids) ? entry.body.external_ids.length : 0);
    }
    const auth = entry.authorized ? '' : ' (bad key)';
    process.stdout.write(entry.method + ' ' + shortPath(entry) + ' -> ' + entry.status + detail + auth + '\n');
  }
}

function pushed() {
  for (const entry of readLog(readStdin())) {
    for (const post of bodyPosts(entry)) {
      process.stdout.write([post.external_id, post.title, post.category === undefined ? '-' : post.category].join('\t') + '\n');
    }
  }
}

function pushedContent(id) {
  let found = null;
  for (const entry of readLog(readStdin())) {
    for (const post of bodyPosts(entry)) {
      if (post.external_id === id) found = post.content;
    }
  }
  if (found === null) process.exit(1);
  process.stdout.write(found + '\n');
}

function deleted() {
  for (const entry of readLog(readStdin())) {
    if (entry.path.slice(-13) === '/posts/delete' && entry.body && Array.isArray(entry.body.external_ids)) {
      for (const id of entry.body.external_ids) process.stdout.write(id + '\n');
    }
  }
}

// Chinese text only comes from the plugin (Hexo's own lines are English), so a
// line with Chinese text but without the prefix would be a missing prefix.
function logLint(files) {
  const han = /[㐀-鿿＀-￯　-〿]/;
  let momobirdLines = 0;
  let bare = 0;
  let broken = 0;
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.indexOf('[MomoBird]') !== -1) momobirdLines += 1;
      if (han.test(line) && line.indexOf('[MomoBird]') === -1) {
        bare += 1;
        process.stdout.write('unprefixed: ' + file + ': ' + line + '\n');
      }
      if (line.indexOf('�') !== -1) {
        broken += 1;
        process.stdout.write('replacement char: ' + file + ': ' + line + '\n');
      }
    }
  }
  process.stdout.write('momobird_lines=' + momobirdLines + ' unprefixed_chinese=' + bare + ' replacement_chars=' + broken + '\n');
  process.exit(bare === 0 && broken === 0 && momobirdLines > 0 ? 0 : 1);
}

async function hexoCategories(site) {
  const Hexo = require(path.join(site, 'node_modules', 'hexo'));
  const hexo = new Hexo(site, { silent: true });
  await hexo.init();
  await hexo.load();
  const PostCategory = hexo.model('PostCategory');
  const Category = hexo.model('Category');
  hexo.model('Post').forEach((post) => {
    const label = (category) => category.name + (category.parent ? '^' : '');
    // post.categories: what the plugin reads. The join table is listed too, to
    // see whether it keeps the order of the front-matter.
    const names = post.categories.toArray().map(label);
    const joined = PostCategory.find({ post_id: post._id })
      .toArray()
      .map((row) => label(Category.findById(row.category_id)));
    process.stdout.write(post.source + '\t' + names.join(',') + '\t' + joined.join(',') + '\n');
  });
  await hexo.exit();
}

function run(args) {
  const mode = args[0];
  const seconds = Number(args[1]);
  const sep = args.indexOf('--');
  if ((mode !== '--stop-after' && mode !== '--limit') || !(seconds > 0) || sep < 0 || sep === args.length - 1) {
    process.stderr.write('usage: run (--stop-after S | --limit S) -- cmd [args...]\n');
    process.exit(2);
  }
  const cmd = args.slice(sep + 1);
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', detached: true });

  let timedOut = false;
  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch (err) {
      // The group is already gone.
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    process.stderr.write('[run] stopping after ' + seconds + ' seconds\n');
    killGroup('SIGTERM');
    setTimeout(() => killGroup('SIGKILL'), 3000).unref();
  }, seconds * 1000);

  child.on('error', (err) => {
    process.stderr.write('[run] cannot start ' + cmd[0] + ': ' + err.message + '\n');
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    killGroup('SIGKILL');
    if (timedOut) process.exit(mode === '--stop-after' ? 0 : 124);
    process.exit(code === null ? 128 + (require('os').constants.signals[signal] || 0) : code);
  });
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'free-port': freePort(); break;
  case 'external-id': process.stdout.write(require('../lib/post-id').externalId(rest[0]) + '\n'); break;
  case 'requests': requests(); break;
  case 'pushed': pushed(); break;
  case 'pushed-content': pushedContent(rest[0]); break;
  case 'deleted': deleted(); break;
  case 'log-lint': logLint(rest); break;
  case 'hexo-categories':
    hexoCategories(rest[0]).catch((err) => {
      process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
      process.exit(1);
    });
    break;
  case 'run': run(rest); break;
  default:
    process.stderr.write('unknown command: ' + command + '\n');
    process.exit(2);
}
