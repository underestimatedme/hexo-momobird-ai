'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { documentText, plainText } = require('../lib/content');

test('documentText puts the title first and keeps the body', () => {
  assert.equal(documentText('T', '<p>你好</p>'), '# T\n\n你好');
});

test('documentText trims the title', () => {
  assert.equal(documentText('  T \n', '<p>x</p>'), '# T\n\nx');
});

test('documentText keeps heading levels as # marks', () => {
  const out = documentText('T', '<h2>小节</h2><p>正文</p>');
  assert.ok(out.includes('## 小节'), out);
  assert.equal(out, '# T\n\n## 小节\n\n正文');

  const deep = documentText('T', '<h1>One</h1><h6>Six</h6>');
  assert.ok(deep.includes('\n# One\n'), deep);
  assert.ok(deep.includes('\n###### Six'), deep);
});

test('documentText strips tags inside headings', () => {
  const out = documentText('T', '<h3 id="x">A <em>b</em> <a href="#x">c</a></h3>');
  assert.equal(out, '# T\n\n### A b c');
});

test('documentText drops script, style, iframe and comments', () => {
  const html = [
    '<p>before</p>',
    '<script>x</script>',
    '<style>p { color: red }</style>',
    '<iframe src="https://example.com/embed" width="560"></iframe>',
    '<!-- c -->',
    '<p>after</p>'
  ].join('');
  assert.equal(documentText('T', html), '# T\n\nbefore\n\nafter');
});

test('documentText drops multi-line script, style, iframe and comment bodies', () => {
  const html = '<p>a</p><script type="text/javascript">\nvar s = "<p>no</p>";\n</script>' +
    '<style>\n.x { }\n</style><iframe\n src="u">\nfallback text\n</iframe><!--\nmulti\nline\n--><p>b</p>';
  assert.equal(documentText('T', html), '# T\n\na\n\nb');
});

test('documentText converts <br> to line breaks and blocks to paragraphs', () => {
  assert.equal(documentText('T', '<p>a<br>b<br/>c<br />d</p><p>e</p>'), '# T\n\na\nb\nc\nd\n\ne');
  assert.equal(documentText('T', '<ul><li>one</li><li>two</li></ul>'), '# T\n\none\n\ntwo');
});

test('documentText drops highlight line-number gutter', () => {
  const html = '<figure class="highlight js"><table><tr><td class="gutter"><pre>' +
    '<span class="line">1</span><br><span class="line">2</span></pre></td>' +
    '<td class="code"><pre><span class="line">let a = 1;</span><br>' +
    '<span class="line">a++;</span></pre></td></tr></table></figure>';
  const out = documentText('T', html);
  assert.ok(out.includes('let a = 1;'), out);
  assert.ok(out.includes('a++;'), out);
  const lines = out.split('\n');
  assert.ok(!lines.includes('1'), out);
  assert.ok(!lines.includes('2'), out);
  assert.equal(out, '# T\n\nlet a = 1;\na++;');
});

test('documentText drops any td whose class contains gutter, with other attributes around', () => {
  const html = '<table><tr><td data-x="1" class=\'line-gutter hl\' title="n">7</td><td class="code">kept</td></tr></table>';
  assert.equal(documentText('T', html), '# T\n\nkept');
});

test('documentText keeps tds that merely look similar', () => {
  const html = '<table><tr><td class="code">a</td><td>b</td></tr></table>';
  assert.equal(documentText('T', html), '# T\n\nab');
});

test('documentText decodes entities after stripping tags', () => {
  assert.equal(
    documentText('T', '<p>&amp;&lt;&gt;&quot;&#39;&nbsp;&#x4e2d;&#20013;</p>'),
    '# T\n\n&<>"\' 中中'
  );
  // An encoded tag is text, not markup, and is not decoded twice.
  assert.equal(documentText('T', '<p>&lt;script&gt;x&lt;/script&gt; &amp;amp;</p>'), '# T\n\n<script>x</script> &amp;');
});

test('documentText leaves unknown entities untouched', () => {
  assert.equal(documentText('T', '<p>a &unknownentity; b &#xZZ; c &#; d</p>'), '# T\n\na &unknownentity; b &#xZZ; c &#; d');
  assert.equal(documentText('T', '<p>&apos;x&apos;</p>'), "# T\n\n'x'");
});

test('documentText leaves invalid numeric entities untouched', () => {
  assert.equal(documentText('T', '<p>&#0; &#xD800; &#1114112;</p>'), '# T\n\n&#0; &#xD800; &#1114112;');
});

test('documentText collapses whitespace and blank lines', () => {
  const html = '<p>  a \t  b  </p>\n\n\n\n<p>c</p><div></div><div></div><p>d</p>';
  assert.equal(documentText('T', html), '# T\n\na b\n\nc\n\nd');
});

test('documentText normalises CRLF', () => {
  assert.equal(documentText('T', '<pre>a\r\nb\rc</pre>'), '# T\n\na\nb\nc');
});

test('documentText returns an empty string when the body is empty', () => {
  assert.equal(documentText('T', ''), '');
  assert.equal(documentText('T', '   \n  '), '');
  assert.equal(documentText('T', '<script>x</script><!-- c --><iframe src="u"></iframe>'), '');
  assert.equal(documentText('T', '<p></p>'), '');
});

test('documentText tolerates missing input', () => {
  assert.equal(documentText('T', undefined), '');
  assert.equal(documentText(undefined, '<p>x</p>'), '# \n\nx');
});

test('plainText strips tags, decodes entities and collapses whitespace', () => {
  assert.equal(plainText('<b>A</b> &amp; B'), 'A & B');
  assert.equal(plainText('  A \n\t B  '), 'A B');
  assert.equal(plainText('a&nbsp;&nbsp;b'), 'a b');
  assert.equal(plainText('x &lt; y'), 'x < y');
  assert.equal(plainText(''), '');
  assert.equal(plainText(undefined), '');
});
