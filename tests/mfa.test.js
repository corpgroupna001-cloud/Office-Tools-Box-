// Two-step verification: what the shared helper decides, and what it asks
// Supabase for. No network: the auth client is a stand-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Run the browser file here rather than in a separate realm, so the objects it
// returns compare as ordinary objects.
const window = {};
new Function('window', fs.readFileSync(path.join(__dirname, '..', 'mfa.js'), 'utf8'))(window);
const M = window.WSMfa;

/** A stand-in Supabase auth client; `plan` decides what each call returns. */
function client(plan = {}) {
  const calls = [];
  const reply = (name, fallback) => async (arg) => {
    calls.push({ name, arg });
    const r = plan[name];
    if (typeof r === 'function') return r(arg);
    if (r instanceof Error) throw r;
    return r || fallback;
  };
  return {
    calls,
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: reply('aal', { data: { currentLevel: 'aal1', nextLevel: 'aal1' } }),
        listFactors: reply('list', { data: { totp: [] } }),
        challengeAndVerify: reply('challengeAndVerify', { error: null }),
        challenge: reply('challenge', { data: { id: 'ch1' }, error: null }),
        verify: reply('verify', { error: null }),
        enroll: reply('enroll', { data: { id: 'f1', totp: { qr_code: 'data:image/svg+xml;utf8,<svg/>', secret: 'ABCDEFGHIJKLMNOP', uri: 'otpauth://totp/x' } }, error: null }),
        unenroll: reply('unenroll', { error: null }),
      },
    },
  };
}

/* ============================ What it decides ============================ */

test('a session owes a code only when the account expects one and has not given it', () => {
  assert.equal(M.needsSecondStep({ currentLevel: 'aal1', nextLevel: 'aal2' }), true);
  assert.equal(M.needsSecondStep({ currentLevel: 'aal2', nextLevel: 'aal2' }), false, 'already done');
  assert.equal(M.needsSecondStep({ currentLevel: 'aal1', nextLevel: 'aal1' }), false, 'no authenticator set up');
  assert.equal(M.needsSecondStep(null), false, 'unknown: do not lock anyone out');
});

test('only finished authenticators count', () => {
  const list = { totp: [{ id: 'a', status: 'verified' }, { id: 'b', status: 'unverified' }, null] };
  assert.deepEqual(M.verifiedFactors(list).map(f => f.id), ['a']);
  assert.deepEqual(M.verifiedFactors({}), []);
  assert.deepEqual(M.verifiedFactors(null), []);
});

test('codes are read as six digits, however they are typed', () => {
  assert.equal(M.normaliseCode(' 123 456 '), '123456');
  assert.equal(M.normaliseCode('12-34-56-78'), '123456');
  assert.equal(M.isCode('123456'), true);
  assert.equal(M.isCode('12345'), false);
  assert.equal(M.isCode('abcdef'), false);
  assert.equal(M.isCode(null), false);
});

test('the secret is shown in groups of four', () => {
  assert.equal(M.groupSecret('ABCDEFGHIJKLMNOP'), 'ABCD EFGH IJKL MNOP');
  assert.equal(M.groupSecret(''), '');
});

test('what Supabase reports becomes something a person can act on', () => {
  assert.match(M.friendly({ message: 'Invalid TOTP code entered' }), /not right/);
  assert.match(M.friendly({ message: 'Token has expired' }), /expired/);
  assert.match(M.friendly({ message: 'Request rate limit reached' }), /Too many tries/);
  assert.match(M.friendly({ message: 'MFA is not enabled' }), /not enabled/);
  assert.match(M.friendly(null), /Try again/);
});

/* ============================ What it asks for ============================ */

test('status reports the second step, the authenticators, and copes with an old client', async () => {
  const sb = client({
    aal: { data: { currentLevel: 'aal1', nextLevel: 'aal2' } },
    list: { data: { totp: [{ id: 'f1', status: 'verified' }] } },
  });
  const s = await M.status(sb);
  assert.equal(s.needs, true);
  assert.equal(s.supported, true);
  assert.deepEqual(s.factors.map(f => f.id), ['f1']);

  const old = { auth: {} };
  const s2 = await M.status(old);
  assert.deepEqual({ needs: s2.needs, supported: s2.supported, factors: s2.factors }, { needs: false, supported: false, factors: [] });
});

test('a code is checked by Supabase; a malformed one never leaves the page', async () => {
  const sb = client();
  assert.deepEqual(await M.submitCode(sb, 'f1', '12345'), { ok: false, message: 'Enter the 6-digit code from your app.' });
  assert.equal(sb.calls.length, 0);

  assert.deepEqual(await M.submitCode(sb, 'f1', '123 456'), { ok: true });
  assert.deepEqual(sb.calls[0], { name: 'challengeAndVerify', arg: { factorId: 'f1', code: '123456' } });

  const bad = client({ challengeAndVerify: { error: { message: 'Invalid TOTP code entered' } } });
  const out = await M.submitCode(bad, 'f1', '000000');
  assert.equal(out.ok, false);
  assert.match(out.message, /not right/);
});

test('setting up an app returns the QR, the secret and the link; failures come back as words', async () => {
  const sb = client();
  const e = await M.beginEnrol(sb, 'Phone');
  assert.equal(e.id, 'f1');
  assert.match(e.qr, /^data:image\/svg\+xml/);
  assert.equal(e.secret, 'ABCDEFGHIJKLMNOP');
  assert.deepEqual(sb.calls[0].arg, { factorType: 'totp', friendlyName: 'Phone' });

  const failed = await M.beginEnrol(client({ enroll: { error: { message: 'MFA is not enabled' } } }));
  assert.match(failed.error, /not enabled/);
});

test('finishing setup challenges first, then verifies with that challenge', async () => {
  const sb = client();
  assert.deepEqual(await M.finishEnrol(sb, 'f1', '123456'), { ok: true });
  assert.deepEqual(sb.calls.map(c => c.name), ['challenge', 'verify']);
  assert.deepEqual(sb.calls[1].arg, { factorId: 'f1', challengeId: 'ch1', code: '123456' });

  const wrong = await M.finishEnrol(client({ verify: { error: { message: 'Invalid TOTP code entered' } } }), 'f1', '123456');
  assert.equal(wrong.ok, false);
  const thrown = await M.finishEnrol({ auth: { mfa: { challenge: () => { throw new Error('offline'); } } } }, 'f1', '123456');
  assert.equal(thrown.ok, false);
});

test('removing an authenticator reports what happened', async () => {
  const sb = client();
  assert.deepEqual(await M.remove(sb, 'f1'), { ok: true });
  assert.deepEqual(sb.calls[0], { name: 'unenroll', arg: { factorId: 'f1' } });
  const denied = await M.remove(client({ unenroll: { error: { message: 'AAL2 required' } } }), 'f1');
  assert.equal(denied.ok, false);
});
