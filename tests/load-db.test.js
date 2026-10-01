// The test database loader refuses to pass quietly (QUAL-03): a missing PGlite
// or a missing migration file is an error unless skipping was asked for.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pglite, checkFiles, BASE, CRM } = require('./fixtures/load-db');

const notInstalled = () => { const e = new Error("Cannot find module '@electric-sql/pglite'"); e.code = 'MODULE_NOT_FOUND'; throw e; };

test('without PGlite the database tests fail, naming the fix', () => {
  assert.throws(() => pglite(notInstalled, {}), /need @electric-sql\/pglite: run `npm ci`/);
  assert.throws(() => pglite(notInstalled, { CI: 'true' }), /npm ci/);
});

test('WS_SKIP_DB_TESTS=1 skips them only when asked, and says so', () => {
  const warn = console.warn; const said = [];
  console.warn = m => said.push(m);
  try {
    pglite.warned = false;
    assert.equal(pglite(notInstalled, { WS_SKIP_DB_TESTS: '1' }), null);
    assert.match(said.join(' '), /SKIPPED/);
  } finally { console.warn = warn; }
});

test('a migration listed but missing from the checkout is an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-loaddb-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.sql'), '');
    assert.doesNotThrow(() => checkFiles(['a.sql'], dir));
    assert.throws(() => checkFiles(['a.sql', 'gone.sql'], dir), /missing: gone\.sql/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every migration the real loader lists is in this checkout', () => {
  assert.doesNotThrow(() => checkFiles([...BASE, ...CRM]));
  assert.ok(pglite(), 'PGlite is installed (npm ci)');
});
