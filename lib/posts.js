'use strict';

// Chooses which Hexo posts MomoBird should hold and maps each one to the body
// of a connect API PUT /posts item, plus a digest of everything that decides
// whether MomoBird has to re-index it.

const crypto = require('crypto');

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

// opts.future: the site's `future` setting. opts.now: the build time.
function isSyncable(post, opts) {
  const options = opts || {};
  if (post.published === false) {
    return false;
  }
  if (isEncrypted(post.password) || isHidden(post.hidden) || isHidden(post.hide) || isOptedOut(post.momobird)) {
    return false;
  }
  if (!options.future && post.date !== undefined && post.date !== null) {
    const now = options.now === undefined || options.now === null ? new Date() : options.now;
    if (post.date.valueOf() > now.valueOf()) {
      return false;
    }
  }
  return true;
}

// The first category without a parent, in the order Hexo returns them. Falls
// back to the first category when all of them have a parent.
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
function mapPost(post, opts) {
  const idOf = (opts && opts.idOf) || externalId;

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
  const category = topCategory(post.categories);
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

module.exports = { isSyncable, topCategory, mapPost, collectLocal };
