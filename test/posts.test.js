'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { isSyncable, topCategory, mapPost, collectLocal } = require('../lib/posts');
const { externalId } = require('../lib/post-id');

const NOW = new Date('2026-10-28T12:00:00.000Z');
const TOMORROW = new Date('2026-10-29T12:00:00.000Z');
const YESTERDAY = new Date('2026-10-27T12:00:00.000Z');

function makePost(overrides) {
  return Object.assign(
    {
      title: 'Hello World',
      slug: 'hello-world',
      source: '_posts/hello-world.md',
      published: true,
      content: '<p>First paragraph.</p>\n<h2>Section</h2>\n<p>Second paragraph.</p>',
      date: new Date('2026-10-01T08:00:00.000Z'),
      updated: new Date('2026-10-02T09:30:00.000Z'),
      permalink: 'https://blog.example.com/2026/10/01/hello-world/',
      categories: []
    },
    overrides
  );
}

// Hexo hands out moment objects; all this code may rely on is valueOf() and
// toISOString().
function momentLike(iso) {
  const ms = Date.parse(iso);
  return {
    valueOf() {
      return ms;
    },
    toISOString() {
      return new Date(ms).toISOString();
    }
  };
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

const opts = { future: false, now: NOW };

// ---------------------------------------------------------------- isSyncable

test('isSyncable accepts an ordinary published post', () => {
  assert.equal(isSyncable(makePost(), opts), true);
});

test('isSyncable skips drafts', () => {
  assert.equal(isSyncable(makePost({ published: false }), opts), false);
});

test('isSyncable treats a missing published flag as published', () => {
  assert.equal(isSyncable(makePost({ published: undefined }), opts), true);
});

test('isSyncable skips encrypted, hidden and opted-out posts', () => {
  assert.equal(isSyncable(makePost({ password: 'x' }), opts), false);
  assert.equal(isSyncable(makePost({ hidden: true }), opts), false);
  assert.equal(isSyncable(makePost({ hide: true }), opts), false);
  assert.equal(isSyncable(makePost({ momobird: false }), opts), false);
});

test('isSyncable keeps posts whose flags are present but not set', () => {
  assert.equal(isSyncable(makePost({ password: '' }), opts), true);
  assert.equal(isSyncable(makePost({ hidden: false }), opts), true);
  assert.equal(isSyncable(makePost({ hide: false }), opts), true);
  assert.equal(isSyncable(makePost({ momobird: true }), opts), true);
  assert.equal(isSyncable(makePost({ momobird: undefined }), opts), true);
});

// Hexo reads front-matter with js-yaml, so an author's "yes", 1 or "true" arrives
// as a string or a number. Hidden, opted-out and encrypted posts must never
// reach MomoBird, so these checks fail closed.

test('isSyncable skips hidden posts whatever way hide or hidden is written', () => {
  const hiding = [true, 1, 2, 'yes', 'Yes', 'YES', 'true', 'True', ' true ', 'on', 'ON', 'anything', '0', 'n', NaN, [], {}];
  for (const key of ['hide', 'hidden']) {
    for (const value of hiding) {
      assert.equal(isSyncable(makePost({ [key]: value }), opts), false, key + ': ' + JSON.stringify(value));
    }
  }
});

test('isSyncable keeps posts whose hide or hidden is clearly off', () => {
  const visible = [undefined, null, false, '', 0, -0, 'false', 'False', 'FALSE', ' false ', 'no', 'No', 'NO', 'off', 'Off', ' OFF '];
  for (const key of ['hide', 'hidden']) {
    for (const value of visible) {
      assert.equal(isSyncable(makePost({ [key]: value }), opts), true, key + ': ' + JSON.stringify(value));
    }
  }
});

test('isSyncable skips posts that opt out with momobird in any falsy spelling', () => {
  const optedOut = [false, 0, -0, 'false', 'False', 'FALSE', ' false ', 'no', 'No', 'NO', 'off', 'Off', ' OFF '];
  for (const value of optedOut) {
    assert.equal(isSyncable(makePost({ momobird: value }), opts), false, 'momobird: ' + JSON.stringify(value));
  }
});

test('isSyncable keeps posts whose momobird value is not an opt-out', () => {
  const kept = [undefined, null, true, 1, 'true', 'yes', 'Yes', 'on', '', 'anything'];
  for (const value of kept) {
    assert.equal(isSyncable(makePost({ momobird: value }), opts), true, 'momobird: ' + JSON.stringify(value));
  }
});

test('isSyncable treats any password value except empty as encrypted', () => {
  const encrypted = ['x', 'hunter2', '0', ' ', 0, 123, 1, true, false, NaN, [], {}];
  for (const value of encrypted) {
    assert.equal(isSyncable(makePost({ password: value }), opts), false, 'password: ' + JSON.stringify(value));
  }
  for (const value of [undefined, null, '']) {
    assert.equal(isSyncable(makePost({ password: value }), opts), true, 'password: ' + JSON.stringify(value));
  }
});

test('isSyncable follows the site future setting for tomorrow posts', () => {
  const post = makePost({ date: TOMORROW });
  assert.equal(isSyncable(post, { future: false, now: NOW }), false);
  assert.equal(isSyncable(post, { future: true, now: NOW }), true);
});

test('isSyncable accepts past posts and posts dated exactly now', () => {
  assert.equal(isSyncable(makePost({ date: YESTERDAY }), opts), true);
  assert.equal(isSyncable(makePost({ date: new Date(NOW.getTime()) }), opts), true);
});

test('isSyncable compares moment-like dates through valueOf', () => {
  assert.equal(isSyncable(makePost({ date: momentLike('2026-10-29T12:00:00.000Z') }), opts), false);
  assert.equal(isSyncable(makePost({ date: momentLike('2026-10-27T12:00:00.000Z') }), opts), true);
  assert.equal(isSyncable(makePost({ date: momentLike('2026-10-29T12:00:00.000Z') }), { future: true, now: NOW }), true);
});

test('isSyncable treats a post without a date as passing the date rule', () => {
  assert.equal(isSyncable(makePost({ date: undefined }), opts), true);
  assert.equal(isSyncable(makePost({ date: null }), opts), true);
});

test('isSyncable still applies the other rules to future posts when future is on', () => {
  const post = makePost({ date: TOMORROW, published: false });
  assert.equal(isSyncable(post, { future: true, now: NOW }), false);
});

// --------------------------------------------------------------- topCategory

test('topCategory prefers the first category without a parent', () => {
  const categories = [{ _id: 'b', name: 'Go', parent: 'a' }, { _id: 'a', name: '技术' }];
  assert.equal(topCategory(categories), '技术');
});

test('topCategory takes the first entry when every category has a parent', () => {
  const categories = [{ _id: 'c', name: 'Go', parent: 'a' }, { _id: 'd', name: 'Rust', parent: 'a' }];
  assert.equal(topCategory(categories), 'Go');
});

test('topCategory keeps Hexo order when there are several top-level categories', () => {
  const categories = [{ _id: 'x', name: '生活' }, { _id: 'y', name: '技术' }];
  assert.equal(topCategory(categories), '生活');
});

test('topCategory accepts a Hexo query with toArray()', () => {
  const query = {
    toArray() {
      return [{ _id: 'b', name: 'Go', parent: 'a' }, { _id: 'a', name: '技术' }];
    }
  };
  assert.equal(topCategory(query), '技术');
});

test('topCategory cuts to 64 characters', () => {
  const name = '分'.repeat(65);
  const result = topCategory([{ _id: 'a', name }]);
  assert.equal(result, '分'.repeat(64));
  assert.equal(Array.from(result).length, 64);
});

test('topCategory counts code points, so a surrogate pair is never split', () => {
  const name = 'a'.repeat(63) + '🚀🚀';
  const result = topCategory([{ _id: 'a', name }]);
  assert.equal(result, 'a'.repeat(63) + '🚀');
  assert.equal(Array.from(result).length, 64);
});

test('topCategory leaves a 64 character name alone', () => {
  const name = 'b'.repeat(64);
  assert.equal(topCategory([{ _id: 'a', name }]), name);
});

test('topCategory returns an empty string when there is no category', () => {
  assert.equal(topCategory([]), '');
  assert.equal(topCategory({ toArray: () => [] }), '');
  assert.equal(topCategory(undefined), '');
  assert.equal(topCategory(null), '');
});

// ------------------------------------------------------------------- mapPost

test('mapPost builds the full payload', () => {
  const post = makePost({
    categories: [{ _id: 'b', name: 'Go', parent: 'a' }, { _id: 'a', name: '技术' }]
  });
  const mapped = mapPost(post);
  assert.equal(mapped.externalId, externalId('_posts/hello-world.md'));
  assert.equal(mapped.source, '_posts/hello-world.md');
  assert.deepEqual(mapped.payload, {
    external_id: externalId('_posts/hello-world.md'),
    title: 'Hello World',
    content: '# Hello World\n\nFirst paragraph.\n\n## Section\n\nSecond paragraph.',
    url: 'https://blog.example.com/2026/10/01/hello-world/',
    modified_at: '2026-10-02T09:30:00.000Z',
    category: '技术'
  });
  assert.match(mapped.digest, /^[0-9a-f]{64}$/);
});

test('mapPost payload external_id equals the LocalPost externalId and is a string', () => {
  const mapped = mapPost(makePost({ source: '_posts/中文 文章.md' }));
  assert.equal(typeof mapped.externalId, 'string');
  assert.equal(mapped.externalId, externalId('_posts/中文 文章.md'));
  assert.equal(mapped.payload.external_id, mapped.externalId);
});

test('mapPost leaves the category key out when the post has none', () => {
  const mapped = mapPost(makePost({ categories: [] }));
  assert.equal(Object.prototype.hasOwnProperty.call(mapped.payload, 'category'), false);
  assert.deepEqual(Object.keys(mapped.payload), ['external_id', 'title', 'content', 'url', 'modified_at']);
});

test('mapPost strips tags and entities from the title', () => {
  const mapped = mapPost(makePost({ title: '<em>Hello</em> &amp; welcome' }));
  assert.equal(mapped.payload.title, 'Hello & welcome');
  assert.ok(mapped.payload.content.startsWith('# Hello & welcome\n\n'));
});

test('mapPost falls back to the slug when the title is empty', () => {
  for (const title of ['', '   ', undefined, null, '<br>']) {
    const mapped = mapPost(makePost({ title, slug: 'my-slug' }));
    assert.equal(mapped.payload.title, 'my-slug', JSON.stringify(title));
    assert.ok(mapped.payload.content.startsWith('# my-slug\n\n'), JSON.stringify(title));
  }
});

test('mapPost cuts the title to 255 characters', () => {
  const mapped = mapPost(makePost({ title: '长'.repeat(300) }));
  assert.equal(mapped.payload.title, '长'.repeat(255));
  assert.ok(mapped.payload.content.startsWith('# ' + '长'.repeat(255) + '\n\n'));
});

test('mapPost cuts a long slug used as the title too', () => {
  const mapped = mapPost(makePost({ title: '', slug: 's'.repeat(300) }));
  assert.equal(mapped.payload.title, 's'.repeat(255));
});

test('mapPost returns null when the body is empty', () => {
  assert.equal(mapPost(makePost({ content: '' })), null);
  assert.equal(mapPost(makePost({ content: '   \n  ' })), null);
  assert.equal(mapPost(makePost({ content: '<p>&nbsp;</p>' })), null);
  assert.equal(mapPost(makePost({ content: '<script>alert(1)</script>' })), null);
  assert.equal(mapPost(makePost({ content: undefined })), null);
});

test('mapPost uses the date when the post was never updated', () => {
  const mapped = mapPost(makePost({ updated: undefined }));
  assert.equal(mapped.payload.modified_at, '2026-10-01T08:00:00.000Z');
});

test('mapPost accepts moment-like dates', () => {
  const mapped = mapPost(
    makePost({ updated: momentLike('2026-10-05T01:02:03.000Z'), date: momentLike('2026-10-01T00:00:00.000Z') })
  );
  assert.equal(mapped.payload.modified_at, '2026-10-05T01:02:03.000Z');
});

test('mapPost digest is the SHA-256 of title, url, category and content', () => {
  const post = makePost({ categories: [{ _id: 'a', name: '技术' }] });
  const mapped = mapPost(post);
  const expected = sha256(
    JSON.stringify([mapped.payload.title, mapped.payload.url, '技术', mapped.payload.content])
  );
  assert.equal(mapped.digest, expected);

  const uncategorised = mapPost(makePost());
  assert.equal(
    uncategorised.digest,
    sha256(JSON.stringify([uncategorised.payload.title, uncategorised.payload.url, '', uncategorised.payload.content]))
  );
});

test('mapPost digest changes when the body changes', () => {
  const before = mapPost(makePost());
  const after = mapPost(makePost({ content: '<p>Something else entirely.</p>' }));
  assert.notEqual(before.digest, after.digest);
});

test('mapPost digest changes when the title, link or category changes', () => {
  const base = mapPost(makePost()).digest;
  assert.notEqual(mapPost(makePost({ title: 'Renamed' })).digest, base);
  assert.notEqual(mapPost(makePost({ permalink: 'https://blog.example.com/new/' })).digest, base);
  assert.notEqual(mapPost(makePost({ categories: [{ _id: 'a', name: '技术' }] })).digest, base);
});

test('mapPost digest ignores changes to updated only', () => {
  const before = mapPost(makePost());
  const after = mapPost(makePost({ updated: new Date('2027-01-01T00:00:00.000Z') }));
  assert.notEqual(before.payload.modified_at, after.payload.modified_at);
  assert.equal(before.digest, after.digest);
});

// ------------------------------------------------------------ categoriesOf

// Hexo's post.categories is in site-wide creation order; the caller can pass
// the post's own order (front-matter order) with opts.categoriesOf.
const TECH = { _id: 't', name: '技术' };
const ZETA = { _id: 'z', name: 'Zeta' };
const INNER = { _id: 'i', name: 'Inner', parent: 'z' };
const ALPHA = { _id: 'a', name: 'Alpha' };
const SITE_ORDER = [TECH, ZETA, INNER, ALPHA];
const FRONT_MATTER_ORDER = [ZETA, INNER, ALPHA, TECH];

test('mapPost takes the category from opts.categoriesOf, so the front-matter-first top-level one wins', () => {
  const post = makePost({ categories: SITE_ORDER });
  assert.equal(mapPost(post).payload.category, '技术');

  const seen = [];
  const mapped = mapPost(post, {
    categoriesOf(candidate) {
      seen.push(candidate);
      return FRONT_MATTER_ORDER;
    }
  });

  assert.equal(mapped.payload.category, 'Zeta');
  assert.deepEqual(seen, [post]);
});

test('mapPost still prefers a parentless category when categoriesOf lists a child first', () => {
  const post = makePost({ categories: SITE_ORDER });
  const mapped = mapPost(post, { categoriesOf: () => [INNER, ZETA, TECH] });
  assert.equal(mapped.payload.category, 'Zeta');
});

test('mapPost sends no category when categoriesOf returns none, whatever post.categories holds', () => {
  const post = makePost({ categories: SITE_ORDER });
  const mapped = mapPost(post, { categoriesOf: () => [] });
  assert.equal(Object.prototype.hasOwnProperty.call(mapped.payload, 'category'), false);
});

test('the digest follows the category categoriesOf chose', () => {
  const post = makePost({ categories: SITE_ORDER });
  const siteWide = mapPost(post);
  const frontMatter = mapPost(post, { categoriesOf: () => FRONT_MATTER_ORDER });
  const again = mapPost(post, { categoriesOf: () => FRONT_MATTER_ORDER.slice() });

  assert.notEqual(frontMatter.digest, siteWide.digest);
  assert.equal(again.digest, frontMatter.digest);
});

test('collectLocal hands every syncable post to opts.categoriesOf', () => {
  const first = makePost({ categories: SITE_ORDER });
  const second = makePost({ source: '_posts/second.md', title: 'Second', slug: 'second', categories: [TECH] });
  const draft = makePost({ source: '_posts/draft.md', published: false });
  const seen = [];

  const { items } = collectLocal(
    [first, second, draft],
    Object.assign(
      {
        categoriesOf(post) {
          seen.push(post.source);
          return post === first ? FRONT_MATTER_ORDER : [];
        }
      },
      opts
    )
  );

  assert.deepEqual(seen, ['_posts/hello-world.md', '_posts/second.md']);
  assert.equal(items.get(externalId('_posts/hello-world.md')).payload.category, 'Zeta');
  assert.equal(Object.prototype.hasOwnProperty.call(items.get(externalId('_posts/second.md')).payload, 'category'), false);
});

// -------------------------------------------------------------- collectLocal

test('collectLocal keeps only syncable posts and keys them by external id', () => {
  const kept = makePost({ source: '_posts/kept.md', title: 'Kept' });
  const posts = [
    kept,
    makePost({ source: '_posts/draft.md', published: false }),
    makePost({ source: '_posts/secret.md', password: 'x' }),
    makePost({ source: '_posts/future.md', date: TOMORROW }),
    makePost({ source: '_posts/empty.md', content: '' })
  ];
  const { items, duplicates } = collectLocal(posts, opts);
  assert.ok(items instanceof Map);
  assert.deepEqual(duplicates, []);
  assert.equal(items.size, 1);
  const item = items.get(externalId('_posts/kept.md'));
  assert.equal(item.source, '_posts/kept.md');
  assert.equal(item.payload.title, 'Kept');
});

test('collectLocal includes future posts when the site shows them', () => {
  const posts = [makePost({ source: '_posts/future.md', date: TOMORROW })];
  assert.equal(collectLocal(posts, { future: false, now: NOW }).items.size, 0);
  assert.equal(collectLocal(posts, { future: true, now: NOW }).items.size, 1);
});

test('collectLocal reports two posts that share an id and keeps the first', () => {
  const first = makePost({ source: '_posts/a.md', title: 'First' });
  const second = makePost({ source: '_posts/b.md', title: 'Second' });
  const { items, duplicates } = collectLocal([first, second], Object.assign({ idOf: () => '42' }, opts));
  assert.deepEqual(duplicates, [['_posts/a.md', '_posts/b.md']]);
  assert.equal(items.size, 1);
  assert.equal(items.get('42').payload.title, 'First');
  assert.equal(items.get('42').source, '_posts/a.md');
});

test('collectLocal reports every later post that collides with the first', () => {
  const posts = [
    makePost({ source: '_posts/a.md' }),
    makePost({ source: '_posts/b.md' }),
    makePost({ source: '_posts/c.md' })
  ];
  const { items, duplicates } = collectLocal(posts, Object.assign({ idOf: () => '7' }, opts));
  assert.equal(items.size, 1);
  assert.deepEqual(duplicates, [
    ['_posts/a.md', '_posts/b.md'],
    ['_posts/a.md', '_posts/c.md']
  ]);
});

test('collectLocal sees duplicates between posts with identical sources', () => {
  const first = makePost({ source: '_posts/same.md', title: 'First' });
  const second = makePost({ source: '_posts/same.md', title: 'Second' });
  const { items, duplicates } = collectLocal([first, second], opts);
  assert.deepEqual(duplicates, [['_posts/same.md', '_posts/same.md']]);
  assert.equal(items.size, 1);
  assert.equal(items.get(externalId('_posts/same.md')).payload.title, 'First');
});

test('collectLocal does not count a skipped post as a duplicate', () => {
  const posts = [
    makePost({ source: '_posts/a.md', published: false }),
    makePost({ source: '_posts/b.md' })
  ];
  const { items, duplicates } = collectLocal(posts, Object.assign({ idOf: () => '1' }, opts));
  assert.deepEqual(duplicates, []);
  assert.equal(items.get('1').source, '_posts/b.md');
});

test('collectLocal uses externalId(post.source) by default', () => {
  const { items } = collectLocal([makePost({ source: '_posts/中文 文章.md' })], opts);
  assert.deepEqual(Array.from(items.keys()), ['3673941822749037']);
});

test('collectLocal accepts a Hexo query with toArray()', () => {
  const query = { toArray: () => [makePost({ source: '_posts/q.md' })] };
  assert.equal(collectLocal(query, opts).items.size, 1);
});

test('collectLocal on no posts returns an empty map and no duplicates', () => {
  const { items, duplicates } = collectLocal([], opts);
  assert.equal(items.size, 0);
  assert.deepEqual(duplicates, []);
});
