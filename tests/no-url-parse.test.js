// DEP0169 ("url.parse() behavior is not standardized ...") in the Vercel logs.
//
// Node 24 only prints DEP0169 for url.parse() calls made OUTSIDE node_modules,
// so web-push and nodemailer are not the source. What is: on Vercel, req.query
// is a lazy getter in the runtime's own launcher that builds itself with
// url.parse(req.url, true) the first time a function reads it. lib/query.js
// reads req.url with the WHATWG URL API instead; these tests pin that down.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { queryOf, queryParam } = require('../lib/query');

test('queryOf reads req.url without touching a lazy req.query getter', () => {
  const req = { url: '/api/attendance-webhook?job=attendance_tick&manual=1&key=a%2Bb' };
  // Vercel defines req.query as a getter that runs url.parse(); reading it is the bug.
  Object.defineProperty(req, 'query', { get() { throw new Error('req.query getter was read'); } });
  assert.equal(queryParam(req, 'job'), 'attendance_tick');
  assert.equal(queryParam(req, 'manual'), '1');
  assert.equal(queryParam(req, 'key'), 'a+b');
  assert.equal(queryParam(req, 'missing'), '');
  assert.equal(queryOf(req), queryOf(req), 'parsed once per request');
});

test('a plain req.query (dev server, tests) is used as is', () => {
  const req = { url: '/x?job=ignored', query: { job: 'shift_switch', n: 5, many: ['a', 'b'] } };
  assert.equal(queryParam(req, 'job'), 'shift_switch');
  assert.equal(queryParam(req, 'n'), '5');
  assert.equal(queryParam(req, 'many'), 'b');
  assert.deepEqual(queryOf({}), {});
  assert.deepEqual(queryOf(null), {});
  assert.deepEqual(queryOf({ url: 'http://[bad' }), {});
});

test('no serverless function reads req.query or calls url.parse() directly', () => {
  const dir = path.join(__dirname, '..', 'api');
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (/\breq\.query\b/.test(code) || /\burl\.parse\(/.test(code)) offenders.push(`api/${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'use queryParam(req, name) from lib/query.js instead');
});

test('url.parse() from our own code would warn; queryOf does not', async () => {
  const seen = [];
  const on = w => { if (w.code === 'DEP0169') seen.push(w); };
  process.on('warning', on);
  queryOf({ url: '/api/x?job=1' });
  await new Promise(r => setTimeout(r, 20));
  process.off('warning', on);
  assert.equal(seen.length, 0);
});
