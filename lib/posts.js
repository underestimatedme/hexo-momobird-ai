'use strict';

// Chooses which Hexo posts MomoBird should hold and maps each one to the body
// of a connect API PUT /posts item, plus a digest of everything that decides
// whether MomoBird has to re-index it.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { externalId } = require('./post-id');
const { documentText, plainText } = require('./content');

const MAX_TITLE_CHARS = 255;
const MAX_CATEGORY_CHARS = 64;

// By Unicode code point, so a surrogate pair is never cut in half.
function truncate(text, max) {
  return Array.from(text).slice(0, max).join('');
}

// Hexo returns warehouse queries from model lookups; accept those and arrays.
function toArray(list) {
  if (list === undefined || list === null) {
    return [];
  }
  if (typeof list.toArray === 'function') {
    return list.toArray();
  }
  return Array.isArray(list) ? list : Array.from(list);
}

// Hexo reads front-matter with js-yaml, so what an author means as a boolean
// can arrive as true, "yes", 1 or "on". A hidden, opted-out or encrypted post
// must never reach MomoBird, so these checks fail closed: when in doubt the
// post is left out.

function isFalseWord(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const word = value.trim().toLowerCase();
  return word === 'false' || word === 'no' || word === 'off';
}

// hide / hidden: only an empty value, false, 0 or "false" / "no" / "off" mean
// "not hidden". Anything else (true, 1, "yes", "on", "anything") hides.
function isHidden(value) {
  if (value === undefined || value === null || value === false || value === '' || value === 0) {
    return false;
  }
  return !isFalseWord(value);
}

// momobird: only false, 0 or "false" / "no" / "off" opt the post out.
function isOptedOut(value) {
  return value === false || value === 0 || isFalseWord(value);
}

// password: any value but undefined, null and '' marks the post encrypted,
// including 0 and 123 that YAML turns unquoted passwords into.
function isEncrypted(value) {
  return !(value === undefined || value === null || value === '');
}

// Why a post stays out of MomoBird, or null when it may go in: 'draft' (a
// file under _drafts), 'unpublished' (`published: false`), 'encrypted',
// 'hidden', 'opted_out' (`momobird: false`) or 'scheduled' (dated in the
// future on a site that does not show such posts). The first rule that
// applies wins.
// opts.future: the site's `future` setting. opts.now: the build time.
function exclusionOf(post, opts) {
  const options = opts || {};
  if (post.published === false) {
    return typeof post.source === 'string' && post.source.indexOf('_drafts/') === 0 ? 'draft' : 'unpublished';
  }
  if (isEncrypted(post.password)) return 'encrypted';
  if (isHidden(post.hidden) || isHidden(post.hide)) return 'hidden';
  if (isOptedOut(post.momobird)) return 'opted_out';
  if (!options.future && post.date !== undefined && post.date !== null) {
    const now = options.now === undefined || options.now === null ? new Date() : options.now;
    if (post.date.valueOf() > now.valueOf()) {
      return 'scheduled';
    }
  }
  return null;
}

function isSyncable(post, opts) {
  return exclusionOf(post, opts) === null;
}

// The first category without a parent, in the order given. Falls back to the
// first category when all of them have a parent.
function topCategory(categories) {
  const list = toArray(categories);
  if (list.length === 0) {
    return '';
  }
  let chosen = list[0];
  for (const category of list) {
    if (category.parent === undefined || category.parent === null) {
      chosen = category;
      break;
    }
  }
  const name = chosen.name === undefined || chosen.name === null ? '' : String(chosen.name);
  return truncate(name, MAX_CATEGORY_CHARS);
}

// opts.idOf replaces externalId, so tests can force two posts onto one id.
// opts.categoriesOf(post) supplies the post's categories in the order its
// author wrote them. Hexo's own post.categories is in the order the categories
// were created on the site, which depends on which post was processed first,
// so the caller passes the order of the post's PostCategory rows instead.
// Without it, post.categories is used.
function mapPost(post, opts) {
  const options = opts || {};
  const idOf = options.idOf || externalId;
  const categoriesOf = typeof options.categoriesOf === 'function' ? options.categoriesOf : null;

  let title = plainText(post.title);
  if (title === '') {
    title = post.slug === undefined || post.slug === null ? '' : String(post.slug);
  }
  title = truncate(title, MAX_TITLE_CHARS);

  const content = documentText(title, post.content);
  if (content === '') {
    return null;
  }

  const id = idOf(post.source);
  const url = post.permalink;
  const category = topCategory(categoriesOf ? categoriesOf(post) : post.categories);
  const payload = {
    external_id: id,
    title,
    content,
    url,
    modified_at: (post.updated || post.date).toISOString()
  };
  if (category !== '') {
    payload.category = category;
  }
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify([title, url, category, content]), 'utf8')
    .digest('hex');
  return { externalId: id, source: post.source, payload, digest };
}

// Keeps the first post when two share an id and reports the pair, so the
// caller can stop the sync instead of silently overwriting one with the other.
function collectLocal(posts, opts) {
  const options = opts || {};
  const items = new Map();
  const duplicates = [];
  for (const post of toArray(posts)) {
    if (!isSyncable(post, options)) {
      continue;
    }
    const mapped = mapPost(post, options);
    if (mapped === null) {
      continue;
    }
    const existing = items.get(mapped.externalId);
    if (existing !== undefined) {
      duplicates.push([existing.source, mapped.source]);
      continue;
    }
    items.set(mapped.externalId, mapped);
  }
  return { items, duplicates };
}

const POSTS_DIR = '_posts';

// Hexo's post processor leaves out temporary files (ending in % or ~) and
// anything with a path segment below _posts/ that starts with _ or .
function isTemporary(name) {
  return /[%~]$/.test(name);
}

function isHiddenName(name) {
  return name.charAt(0) === '_' || name.charAt(0) === '.';
}

function ignoreMissing(err) {
  if (err && err.code === 'ENOENT') return null;
  throw err;
}

// The files Hexo would read as posts: every file under <sourceDir>/_posts its
// post processor accepts, in the form Hexo gives post.source ("_posts/" plus
// the path below it, "/"-separated). `isRenderable(source)` is Hexo's own
// check (hexo.render.isRenderable). Like Hexo's walk it follows symlinks and
// passes over entries that vanish, and any other error (a directory it may
// not read) is thrown, so the caller never mistakes a partial list for the
// whole. A symlink back to a directory it is already inside is not followed.
//
// It does not apply `skip_render`, `ignore` or the `post_asset_folder`
// extension rule: such a file can only be on MomoBird if Hexo once read it as
// a post, and keeping it online is the safe side.
function listPostFiles(sourceDir, isRenderable) {
  const found = [];
  const inside = new Set();

  function walk(dir, prefix) {
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch (err) {
      ignoreMissing(err);
      return;
    }
    if (inside.has(real)) return;
    inside.add(real);
    try {
      list(dir, prefix);
    } finally {
      inside.delete(real);
    }
  }

  function list(dir, prefix) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      ignoreMissing(err);
      return;
    }
    for (const name of names.sort()) {
      if (isHiddenName(name)) continue;
      const full = path.join(dir, name);
      let stats;
      try {
        stats = fs.statSync(full);
      } catch (err) {
        ignoreMissing(err);
        continue;
      }
      const source = prefix + '/' + name;
      if (stats.isDirectory()) {
        walk(full, source);
      } else if (!isTemporary(name) && isRenderable(source)) {
        found.push(source);
      }
    }
  }

  walk(path.join(sourceDir, POSTS_DIR), POSTS_DIR);
  return found;
}

module.exports = { isSyncable, exclusionOf, topCategory, mapPost, collectLocal, listPostFiles };
