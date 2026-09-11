// Board templates: every template is a well-formed drawing that passes the
// same check as stored data, each new board gets its own copy, and previews
// escape text. Loads boards/whiteboard.js as the browser would.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'boards', 'whiteboard.js'), 'utf8'), { window });
const WB = window.WSWhiteboard;
const TYPES = ['path', 'rect', 'ellipse', 'line', 'arrow', 'text', 'note'];

test('the picker lists named templates, blank first; blank and unknown ones are empty', () => {
  assert.ok(WB.templates.length >= 8);
  assert.equal(WB.templates[0].key, 'blank');
  for (const t of WB.templates) { assert.ok(t.name && t.hint, t.key); assert.equal(typeof t.build, 'undefined', 'only the description is exposed'); }
  assert.equal(WB.template('blank').length, 0);
  assert.equal(WB.template('nope').length, 0);
});

test('every template is a well-formed drawing', () => {
  for (const { key } of WB.templates.filter(t => t.key !== 'blank')) {
    const els = WB.template(key);
    assert.ok(els.length >= 6, `${key} has something on it`);
    assert.equal(new Set(els.map(e => e.id)).size, els.length, `${key}: ids are unique`);
    for (const e of els) {
      assert.ok(TYPES.includes(e.type), `${key}: ${e.type}`);
      assert.match(e.color, /^#[0-9a-f]{6}$/i);
      if (e.fill) assert.match(e.fill, /^#[0-9a-f]{6}$/i);
      const nums = e.points ? e.points.flat() : [e.x, e.y, e.w, e.h];
      nums.forEach(n => assert.ok(Number.isFinite(n), `${key}: ${e.type} coordinates`));
      if (!e.points) assert.ok(e.w > 0 && e.h > 0, `${key}: ${e.type} has a size`);
      if (e.type === 'text') assert.ok(e.text, `${key}: no empty labels`);
    }
    assert.equal(WB.previewSvg(els).length > 0, true);
  }
});

test('each new board gets its own copy with new ids', () => {
  const a = WB.template('swot'), b = WB.template('swot');
  assert.equal(a.length, b.length);
  assert.ok(a.every(e => !b.some(x => x.id === e.id)));
  a[0].x = 9999;
  assert.notEqual(WB.template('swot')[0].x, 9999);
});

test('previews are SVG, escape text and drop anything that is not a drawing', () => {
  const s = WB.previewSvg([{ type: 'text', x: 0, y: 0, w: 100, h: 30, text: '<img src=x onerror=alert(1)>', color: 'red;background:url(x)' }], 320);
  assert.match(s, /^<svg /);
  assert.ok(!s.includes('<img'));
  assert.ok(s.includes('&lt;img'));
  assert.ok(!s.includes('url(x)'), 'colours must be plain hex');
  assert.ok(!WB.previewSvg([{ type: 'script', text: 'alert(1)' }]).includes('alert'));
});
