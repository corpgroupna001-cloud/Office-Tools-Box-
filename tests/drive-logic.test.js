'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../documents/drive-logic.js');

test('sanitizeHtml keeps formatting and drops anything that can run', () => {
  assert.equal(D.sanitizeHtml('<p style="text-align: center">Hi <b>there</b></p>'), '<p style="text-align: center">Hi <b>there</b></p>');
  assert.equal(D.sanitizeHtml('<script>alert(1)</script><p>ok</p>'), '<p>ok</p>');
  assert.equal(D.sanitizeHtml('<img src=x onerror=alert(1)>text'), 'text');
  assert.equal(D.sanitizeHtml('<p onclick="x()" class="y">a</p>'), '<p>a</p>');
  assert.equal(D.sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(D.sanitizeHtml('<a href="java&#x09;script&colon;alert(1)">x</a>'), '<a>x</a>');
  assert.equal(D.sanitizeHtml('<a href="//evil.example/">x</a>'), '<a>x</a>', 'protocol-relative links are refused');
  assert.equal(D.sanitizeHtml('<a href="https://example.com/?a=1&amp;b=2">x</a>'), '<a href="https://example.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">x</a>');
  assert.equal(D.sanitizeHtml('<p style="background:url(javascript:x);color:#f00">a</p>'), '<p style="color:#f00">a</p>');
  assert.equal(D.sanitizeHtml('1 < 2 & 3 > 2'), '1 &lt; 2 &amp; 3 &gt; 2');
  assert.equal(D.sanitizeHtml('<scr<script>ipt>alert(1)</script>'), '&lt;scr');
  assert.equal(D.sanitizeHtml('<b><i>open'), '<b><i>open</i></b>', 'unclosed tags are closed');
  assert.equal(D.sanitizeHtml('</b>stray'), 'stray');
  assert.equal(D.sanitizeHtml('<!-- hidden --><p>x</p>'), '<p>x</p>');
  assert.equal(D.sanitizeHtml('<svg><script>a</script></svg><p>b</p>'), '<p>b</p>');
  assert.equal(D.sanitizeHtml('<iframe src="https://x"></iframe>'), '');
  assert.equal(D.sanitizeHtml('a &nbsp; &#169; b'), 'a &nbsp; &#169; b');
  assert.equal(D.sanitizeHtml(null), '');
});

test('htmlToText gives readable plain text', () => {
  assert.equal(D.htmlToText('<h1>Title</h1><p>One &amp; two</p><ul><li>a</li><li>b</li></ul>'), 'Title\nOne & two\na\nb');
});

test('column names and references', () => {
  assert.equal(D.colName(0), 'A');
  assert.equal(D.colName(25), 'Z');
  assert.equal(D.colName(26), 'AA');
  assert.equal(D.colName(701), 'ZZ');
  assert.equal(D.colIndex('AA'), 26);
  assert.deepEqual(D.parseRef('B12'), { c: 1, r: 11 });
  assert.deepEqual(D.parseRef('$c$3'), { c: 2, r: 2 });
  assert.equal(D.parseRef('12'), null);
});

test('evaluateSheet: arithmetic, functions, ranges and errors', () => {
  const v = D.evaluateSheet({
    A1: '10', A2: '20', A3: '30', A4: '=SUM(A1:A3)', A5: '=AVERAGE(A1:A3)',
    B1: '=A1*2+A2/4', B2: '=(A1+A2)*-1', B3: '=2^3^2', B4: '=50%', B5: '=ROUND(10/3, 2)',
    C1: '=A1/0', C2: '=C1+1', C3: '=D1', D1: '=C3', C4: '=FOO(1)', C5: '=A1+', C6: 'text', C7: '=C6*2',
    E1: '=MAX(A1:A3, 99)', E2: '=MIN(A1:A3)', E3: '=COUNT(A1:B5)', E4: '=ABS(-4)', E5: '', E6: '=SUM(A1:C1)',
  });
  assert.equal(v.A4, 60);
  assert.equal(v.A5, 20);
  assert.equal(v.B1, 25);
  assert.equal(v.B2, -30);
  assert.equal(v.B3, 512);
  assert.equal(v.B4, 0.5);
  assert.equal(v.B5, 3.33);
  assert.equal(v.C1, '#DIV/0!');
  assert.equal(v.C2, '#DIV/0!', 'errors spread');
  assert.equal(v.C3, '#CYCLE!');
  assert.equal(v.C4, '#NAME?');
  assert.equal(v.C5, '#ERROR!');
  assert.equal(v.C7, '#VALUE!');
  assert.equal(v.E1, 99);
  assert.equal(v.E2, 10);
  assert.equal(v.E3, 10);
  assert.equal(v.E6, '#DIV/0!', 'a range holding an error gives the error');
  assert.equal(v.E4, 4);
  assert.equal(v.E5, '');
});

test('sheet CSV export evaluates formulas and defuses spreadsheet injection', () => {
  const csv = D.sheetToCsv({ cells: { A1: 'Item', B1: 'Qty', A2: 'Pens, blue', B2: '3', A3: '=HYPERLINK', B3: '=B2*2', A4: '-1' } });
  assert.equal(csv, 'Item,Qty\r\n"Pens, blue",3\r\n#NAME?,6\r\n-1,');
  assert.deepEqual(D.csvToCells([['a', '1'], ['', '2']]), { A1: 'a', B1: '1', B2: '2' });
  assert.deepEqual(D.extent({ A1: 'x', C4: '1', Z9: '' }), { cols: 3, rows: 4 });
});

test('normalise keeps stored content safe to render', () => {
  assert.equal(D.normalise('document', { html: '<p onclick="x">a<o:p></o:p></p><script>1</script>' }).html, '<p>a</p>');
  const sh = D.normalise('spreadsheet', { sheets: [{ name: 'S', cells: { a1: '1', B2: { v: 2, b: 1, a: 'zz' }, 'X!': 'bad', C3: '' }, widths: { 0: 120, 1: 9999, x: 50 } }] });
  assert.deepEqual(sh.sheets[0].cells, { A1: '1', B2: { v: '2', b: true } });
  assert.deepEqual(sh.sheets[0].widths, { 0: 120 });
  assert.equal(D.normalise('spreadsheet', {}).sheets.length, 1);
  const pr = D.normalise('presentation', { slides: [{ layout: 'weird', title: 'T', bg: 'red;background:url(x)' }] });
  assert.equal(pr.slides[0].layout, 'content');
  assert.equal(pr.slides[0].bg, '#ffffff', 'only #rrggbb reaches a style attribute');
  assert.equal(D.normalise('presentation', null).slides.length, 1);
});

test('read-only views escape text and use the same slide markup as the editor', () => {
  const html = D.renderStatic('presentation', { slides: [{ layout: 'content', title: '<b>Plan</b>', body: '- one\n- two', bg: '#1f2a36' }] });
  assert.match(html, /&lt;b&gt;Plan&lt;\/b&gt;/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /color:#ffffff/);
  assert.doesNotMatch(D.slideHtml({ title: 'x' }), /contenteditable/);
  assert.match(D.slideHtml({ title: 'x' }, { editable: true }), /contenteditable="true"/);
  const sheet = D.renderStatic('spreadsheet', { sheets: [{ name: 'S', cells: { A1: '<img src=x>', B1: '=1+1' } }] });
  assert.match(sheet, /<td>&lt;img src=x&gt;<\/td>/);
  assert.match(sheet, /<td class="num">2<\/td>/);
  assert.equal(D.renderStatic('document', { html: '<p>x</p>' }), '<article class="ds-doc"><p>x</p></article>');
  assert.equal(D.textColorFor('#ffffff'), '#1f2a36');
  assert.equal(D.textColorFor('#1f2a36'), '#ffffff');
});

test('tokens and file names', () => {
  const t = D.newToken();
  assert.ok(t.length >= 32 && /^[a-z0-9]+$/.test(t));
  assert.notEqual(D.newToken(), t);
  assert.equal(D.fileName('Q4 / plan: draft', 'doc'), 'Q4 plan draft.doc');
  assert.equal(D.fileName('Report.csv', 'csv'), 'Report.csv');
  assert.equal(D.fileName('', 'csv'), 'Untitled.csv');
  assert.equal(D.KINDS.spreadsheet.blank().sheets.length, 1);
});
