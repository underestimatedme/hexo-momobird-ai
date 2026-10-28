'use strict';

// Turns the rendered HTML of a Hexo post into the plain-text document MomoBird
// indexes: a "# title" line, then the body with heading levels kept as "#"
// marks. The rules mirror ContentTransformer::normalize in the WordPress and
// Typecho plugins, plus two for Hexo output: <iframe> embeds and the
// line-number gutter of highlighted code blocks are dropped.

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
};

function stripTags(text) {
  return text.replace(/<\/?[A-Za-z][^>]*>/g, '');
}

// One pass over the text, so "&amp;lt;" becomes "&lt;" and not "<". Anything
// that is not a known or valid entity is left exactly as written.
function decodeEntities(text) {
  return text.replace(/&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g, (match, dec, hex, name) => {
    if (name !== undefined) {
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : match;
    }
    const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    const isSurrogate = code >= 0xd800 && code <= 0xdfff;
    if (code === 0 || code > 0x10ffff || isSurrogate) {
      return match;
    }
    return String.fromCodePoint(code);
  });
}

function normalize(html) {
  let text = html === undefined || html === null ? '' : String(html);
  text = text.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '');
  // The line numbers of a highlighted code block live in <td class="gutter">.
  text = text.replace(
    /<td\b(?=[^>]*\bclass\s*=\s*(?:"[^"]*gutter[^"]*"|'[^']*gutter[^']*'))[^>]*>[\s\S]*?<\/td\s*>/gi,
    ''
  );
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (match, level, inner) => {
    return '\n\n' + '#'.repeat(Number(level)) + ' ' + stripTags(inner) + '\n\n';
  });
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(?:p|div|li|blockquote|pre|section|article|ul|ol|table|tr|figure|figcaption)>/gi, '\n\n');
  text = stripTags(text);
  text = decodeEntities(text);
  text = text.replace(/\r\n|\r/g, '\n');
  text = text
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function documentText(title, html) {
  const body = normalize(html);
  if (body === '') {
    return '';
  }
  const heading = title === undefined || title === null ? '' : String(title).trim();
  return '# ' + heading + '\n\n' + body;
}

// For titles: tags removed, entities decoded, whitespace collapsed.
function plainText(html) {
  const text = decodeEntities(stripTags(html === undefined || html === null ? '' : String(html)));
  return text.replace(/\s+/g, ' ').trim();
}

module.exports = { documentText, plainText };
