// Which webhooks a punch line may go out through, and which Bitrix refusals
// mean "try another person's webhook" rather than "the group is wrong".
const test = require('node:test');
const assert = require('node:assert/strict');
const bitrix = require('../lib/bitrix');

const hook = n => `https://p.bitrix24.com/rest/${n}/secret${n}/`;

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(process.env)) if (k.startsWith('BITRIX_')) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith('BITRIX_')) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test('own hook first, then the company hook, colleagues, everyone else - each once', () => {
  withEnv({
    BITRIX_HOOK_00000008: hook(8), BITRIX_HOOK_00000002: hook(2), BITRIX_HOOK_00000101: hook(101),
    BITRIX_HOOK_00000003: hook(2),            // same URL pasted twice: tried once
    BITRIX_WEBHOOK_URL: hook(1),
  }, () => {
    const list = bitrix.sendersFor({ enroll: '00000008', companyEnrolls: ['00000008', '00000002'] });
    assert.deepEqual(list.map(s => `${s.via}:${s.enroll}`),
      ['own:00000008', 'company:null', 'colleague:00000002', 'any:00000101']);
    assert.equal(bitrix.senderFor({ enroll: '00000008' }).base, list[0].base, 'same first choice as senderFor');
  });
});

test('someone with no hook of their own starts with a colleague', () => {
  withEnv({ BITRIX_HOOK_00000002: hook(2), BITRIX_HOOK_00000101: hook(101) }, () => {
    const list = bitrix.sendersFor({ enroll: '00000999', companyEnrolls: ['00000002'] });
    assert.deepEqual(list.map(s => s.via), ['colleague', 'any']);
  });
  withEnv({}, () => assert.deepEqual(bitrix.sendersFor({ enroll: '1' }), []));
});

test('refusals about the webhook are retried elsewhere; outages and bad groups are not', () => {
  for (const reason of ['ACCESS_ERROR', 'invalid_token', 'expired_token', 'insufficient_scope', 'NO_AUTH_FOUND', 'http_401', 'QUERY_LIMIT_EXCEEDED']) {
    assert.equal(bitrix.isSenderRefusal({ ok: false, reason }), true, reason);
  }
  assert.equal(bitrix.isSenderRefusal({ ok: false, reason: 'ERROR', detail: 'You do not have access to this chat' }), true);
  for (const reason of ['timeout', 'network', 'bad_dialog', 'no_dialog', 'empty', 'CANCELED']) {
    assert.equal(bitrix.isSenderRefusal({ ok: false, reason, detail: '' }), false, reason);
  }
  assert.equal(bitrix.isSenderRefusal({ ok: true }), false);
});
