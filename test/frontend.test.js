'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  widgetSnippet,
  podcastScriptTag,
  podcastPlaceholder,
  decoratePostLocals
} = require('../lib/frontend');

const SOURCE = '0f8fad5b-d9cb-469f-a165-70867728950e';

test('widgetSnippet renders the loader script on the right by default', () => {
  assert.equal(
    widgetSnippet('abc_DEF-123', 'right'),
    '<script defer src="https://momobird.atlaspaces.com/widget/loader.v1.js" data-project="abc_DEF-123"></script>'
  );
  assert.equal(widgetSnippet('abc_DEF-123'), widgetSnippet('abc_DEF-123', 'right'));
});

test('widgetSnippet adds data-position for the left side', () => {
  assert.equal(
    widgetSnippet('abc_DEF-123', 'left'),
    '<script defer src="https://momobird.atlaspaces.com/widget/loader.v1.js" data-project="abc_DEF-123" data-position="left"></script>'
  );
});

test('widgetSnippet returns an empty string for an invalid public id', () => {
  assert.equal(widgetSnippet('a"b', 'right'), '');
  assert.equal(widgetSnippet('a b', 'right'), '');
  assert.equal(widgetSnippet('a<b>', 'left'), '');
  assert.equal(widgetSnippet('abc\n', 'right'), '');
  assert.equal(widgetSnippet('', 'right'), '');
  assert.equal(widgetSnippet('a'.repeat(129), 'right'), '');
  assert.equal(widgetSnippet(undefined, 'right'), '');
  assert.equal(widgetSnippet(null, 'right'), '');
  assert.equal(widgetSnippet(123, 'right'), '');
  assert.notEqual(widgetSnippet('a'.repeat(128), 'right'), '');
});

test('podcastScriptTag renders the player script', () => {
  assert.equal(
    podcastScriptTag(),
    '<script defer src="https://momobird.atlaspaces.com/widget/podcast.v1.js"></script>'
  );
});

test('podcastPlaceholder renders the hidden element without a transcript', () => {
  assert.equal(
    podcastPlaceholder({
      sourceId: SOURCE,
      externalId: '2771473582013371',
      api: 'https://api.valley.atlaspaces.com',
      transcript: false
    }),
    '<div class="momobird-podcast" data-source="0f8fad5b-d9cb-469f-a165-70867728950e" data-post="2771473582013371" data-api="https://api.valley.atlaspaces.com"></div>'
  );
});

test('podcastPlaceholder adds data-transcript when the transcript is on', () => {
  assert.equal(
    podcastPlaceholder({
      sourceId: SOURCE,
      externalId: '2771473582013371',
      api: 'https://api.valley.atlaspaces.com',
      transcript: true
    }),
    '<div class="momobird-podcast" data-source="0f8fad5b-d9cb-469f-a165-70867728950e" data-post="2771473582013371" data-api="https://api.valley.atlaspaces.com" data-transcript="1"></div>'
  );
});

test('podcastPlaceholder strips trailing slashes from api', () => {
  const html = podcastPlaceholder({
    sourceId: SOURCE,
    externalId: '42',
    api: 'https://api.valley.atlaspaces.com/',
    transcript: false
  });
  assert.ok(html.includes('data-api="https://api.valley.atlaspaces.com"'), html);
  assert.ok(!html.includes('atlaspaces.com/"'), html);
});

test('podcastPlaceholder accepts a numeric external id and upper-case uuid', () => {
  const html = podcastPlaceholder({
    sourceId: SOURCE.toUpperCase(),
    externalId: 42,
    api: 'http://localhost:8080',
    transcript: false
  });
  assert.equal(
    html,
    '<div class="momobird-podcast" data-source="0F8FAD5B-D9CB-469F-A165-70867728950E" data-post="42" data-api="http://localhost:8080"></div>'
  );
});

test('podcastPlaceholder returns an empty string for a bad source id', () => {
  const base = { externalId: '42', api: 'https://api.valley.atlaspaces.com', transcript: false };
  assert.equal(podcastPlaceholder({ ...base, sourceId: 'not-a-uuid' }), '');
  assert.equal(podcastPlaceholder({ ...base, sourceId: SOURCE + '\n' }), '');
  assert.equal(podcastPlaceholder({ ...base, sourceId: '"' + SOURCE }), '');
  assert.equal(podcastPlaceholder({ ...base, sourceId: '' }), '');
  assert.equal(podcastPlaceholder({ ...base, sourceId: undefined }), '');
});

test('podcastPlaceholder returns an empty string for a bad external id', () => {
  const base = { sourceId: SOURCE, api: 'https://api.valley.atlaspaces.com', transcript: false };
  assert.equal(podcastPlaceholder({ ...base, externalId: '' }), '');
  assert.equal(podcastPlaceholder({ ...base, externalId: 'abc' }), '');
  assert.equal(podcastPlaceholder({ ...base, externalId: '12a' }), '');
  assert.equal(podcastPlaceholder({ ...base, externalId: '12\n' }), '');
  assert.equal(podcastPlaceholder({ ...base, externalId: '1'.repeat(21) }), '');
  assert.equal(podcastPlaceholder({ ...base, externalId: '"><script>' }), '');
  assert.equal(podcastPlaceholder({ ...base, externalId: undefined }), '');
  assert.notEqual(podcastPlaceholder({ ...base, externalId: '1'.repeat(20) }), '');
});

test('podcastPlaceholder escapes attribute values', () => {
  const html = podcastPlaceholder({
    sourceId: SOURCE,
    externalId: '42',
    api: 'https://a.example/x"y\'z<&>',
    transcript: false
  });
  assert.equal(
    html,
    '<div class="momobird-podcast" data-source="0f8fad5b-d9cb-469f-a165-70867728950e" data-post="42" data-api="https://a.example/x&quot;y&#39;z&lt;&amp;&gt;"></div>'
  );
});

class FakePost {
  constructor() {
    this.title = 'Hello';
    this.content = '<p>body</p>';
    this.__post = true;
    this.source = '_posts/hello.md';
  }

  // A virtual getter on the prototype, like Hexo's Warehouse documents.
  get permalink() {
    return 'https://blog.example/' + this.source.replace(/^_posts\//, '').replace(/\.md$/, '/');
  }
}

test('decoratePostLocals prepends the placeholder to the post content', () => {
  const page = new FakePost();
  const locals = { page, config: { url: 'https://blog.example' } };
  const seen = [];

  const result = decoratePostLocals(locals, (p) => {
    seen.push(p);
    return '<div id="ph"></div>';
  });

  assert.equal(result, locals);
  assert.deepEqual(seen, [page]);
  assert.equal(result.page.content, '<div id="ph"></div><p>body</p>');
  assert.equal(result.config.url, 'https://blog.example');
});

test('decoratePostLocals leaves the original page object untouched', () => {
  const page = new FakePost();
  const before = Object.assign({}, page);
  const ownKeys = Object.getOwnPropertyNames(page).sort();

  const result = decoratePostLocals({ page }, () => '<div id="ph"></div>');

  assert.notEqual(result.page, page);
  assert.equal(page.content, '<p>body</p>');
  assert.deepEqual(Object.assign({}, page), before);
  assert.deepEqual(Object.getOwnPropertyNames(page).sort(), ownKeys);
});

test('decoratePostLocals keeps the page readable through its prototype', () => {
  const page = new FakePost();
  const result = decoratePostLocals({ page }, () => '<div id="ph"></div>');

  assert.equal(result.page.title, 'Hello');
  assert.equal(result.page.source, '_posts/hello.md');
  assert.equal(result.page.__post, true);
  assert.equal(result.page.permalink, 'https://blog.example/hello/');
  assert.ok(Object.getPrototypeOf(result.page) === page);
});

test('decoratePostLocals works when content is a read-only inherited property', () => {
  const page = Object.freeze({ __post: true, title: 'Frozen', content: '<p>x</p>' });
  const result = decoratePostLocals({ page }, () => '<i></i>');

  assert.equal(result.page.content, '<i></i><p>x</p>');
  assert.equal(page.content, '<p>x</p>');
});

test('decoratePostLocals treats a missing content as empty', () => {
  const page = { __post: true, title: 'No body' };
  const result = decoratePostLocals({ page }, () => '<i></i>');

  assert.equal(result.page.content, '<i></i>');
});

test('decoratePostLocals does not decorate twice when the filter runs again', () => {
  const page = new FakePost();
  const locals = { page };
  let calls = 0;
  const placeholderFor = () => {
    calls += 1;
    return '<i></i>';
  };

  decoratePostLocals(locals, placeholderFor);
  const once = locals.page;
  decoratePostLocals(locals, placeholderFor);

  assert.equal(locals.page, once);
  assert.equal(locals.page.content, '<i></i><p>body</p>');
  assert.equal(calls, 1);
});

test('decoratePostLocals returns non-post pages unchanged', () => {
  const page = { title: 'About', content: '<p>about</p>' };
  const locals = { page };
  let called = false;

  const result = decoratePostLocals(locals, () => {
    called = true;
    return '<i></i>';
  });

  assert.equal(result, locals);
  assert.equal(result.page, page);
  assert.equal(result.page.content, '<p>about</p>');
  assert.equal(called, false);
});

test('decoratePostLocals returns the locals unchanged when there is no placeholder', () => {
  const page = new FakePost();
  const locals = { page };

  const result = decoratePostLocals(locals, () => '');

  assert.equal(result, locals);
  assert.equal(result.page, page);
  assert.equal(page.content, '<p>body</p>');
});

test('decoratePostLocals tolerates locals without a page', () => {
  const locals = { config: {} };
  assert.equal(decoratePostLocals(locals, () => '<i></i>'), locals);
  assert.equal(decoratePostLocals(null, () => '<i></i>'), null);
  assert.equal(decoratePostLocals(undefined, () => '<i></i>'), undefined);
});
