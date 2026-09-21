// The sign-in card must stay below the dialogs sign-in opens (two-step code,
// email code, errors), or they open invisibly behind it and sign-in stalls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('nothing raises #auth-modal above the sign-in dialogs', () => {
  for (const f of ['ui/b24.css', 'ui/corporate.css', 'ui/app.css', 'index.html']) {
    const css = read(f);
    for (const m of css.matchAll(/#auth-modal[^{]*\{([^}]*)\}/g)) {
      const z = /z-index:\s*(\d+)/.exec(m[1]);
      assert.ok(!z || Number(z[1]) < 80, `${f}: #auth-modal z-index ${z && z[1]} would cover the code dialog (80)`);
    }
  }
  assert.match(read('index.html'), /host\.className = 'fixed inset-0 z-\[80\]/, 'the code dialog sits at 80');
});
