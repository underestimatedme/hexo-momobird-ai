'use strict';

const LOADER_SRC = 'https://momobird.atlaspaces.com/widget/loader.v1.js';
const PODCAST_SRC = 'https://momobird.atlaspaces.com/widget/podcast.v1.js';

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SOURCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTERNAL_ID_PATTERN = /^[0-9]{1,20}$/;

// Marks a page object that already carries the podcast placeholder, so a
// second run of the template_locals filter (for example when Hexo renders a
// layout around the post view) does not add it again.
const DECORATED = Symbol('momobird.podcast');

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The Q&A widget loader. The public id is the only variable part and is
// matched against a strict pattern, so nothing needs escaping; anything that
// does not match produces no markup at all.
function widgetSnippet(publicId, position) {
  if (typeof publicId !== 'string' || !PUBLIC_ID_PATTERN.test(publicId)) return '';
  const side = position === 'left' ? ' data-position="left"' : '';
  return '<script defer src="' + LOADER_SRC + '" data-project="' + publicId + '"' + side + '></script>';
}

// The podcast player script, loaded once on post pages.
function podcastScriptTag() {
  return '<script defer src="' + PODCAST_SRC + '"></script>';
}

// The hidden element the player script looks for. Returns '' unless both ids
// are well formed, so a bad value can never reach the page.
function podcastPlaceholder(options) {
  const opts = options || {};
  const sourceId = opts.sourceId;
  if (typeof sourceId !== 'string' || !SOURCE_PATTERN.test(sourceId)) return '';

  const raw = opts.externalId;
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';
  const externalId = String(raw);
  if (!EXTERNAL_ID_PATTERN.test(externalId)) return '';

  const api = String(opts.api == null ? '' : opts.api).replace(/\/+$/, '');
  const transcript = opts.transcript ? ' data-transcript="1"' : '';

  return (
    '<div class="momobird-podcast"' +
    ' data-source="' + escapeAttribute(sourceId) + '"' +
    ' data-post="' + escapeAttribute(externalId) + '"' +
    ' data-api="' + escapeAttribute(api) + '"' +
    transcript +
    '></div>'
  );
}

// template_locals filter body. On a post page it swaps `locals.page` for a
// thin object that inherits from the real page and only overrides `content`
// (placeholder first). The original page is never written to: Hexo keeps
// rendered post bodies in its cache, and in some versions `locals.page` is the
// post document itself. Reads of title, permalink and other getters still work
// through the prototype chain.
function decoratePostLocals(locals, placeholderFor) {
  if (!locals) return locals;
  const page = locals.page;
  if (!page || !page.__post || page[DECORATED]) return locals;

  const placeholder = placeholderFor(page);
  if (!placeholder) return locals;

  const decorated = Object.create(page);
  Object.defineProperty(decorated, DECORATED, { value: true });
  // defineProperty, not assignment: an inherited read-only or accessor
  // `content` would make a plain assignment fail.
  Object.defineProperty(decorated, 'content', {
    value: placeholder + (page.content == null ? '' : String(page.content)),
    writable: true,
    enumerable: true,
    configurable: true
  });

  locals.page = decorated;
  return locals;
}

module.exports = { widgetSnippet, podcastScriptTag, podcastPlaceholder, decoratePostLocals };
