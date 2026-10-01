// lib/setup-health.js and the admin action behind Admin → Overview → Setup
// health (F-01): states and remedies, never a secret value, reads only.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../lib/setup-health');

const SECRETS = { SUPABASE_URL: 'https://proj.supabase.example', SUPABASE_ANON_KEY: 'anon-SECRET-1', SUPABASE_SERVICE_ROLE_KEY: 'service-SECRET-2',
  ADMIN_PASSWORD: 'a-long-admin-SECRET-3', MAIL_API_KEY: 'mail-SECRET-4', SMTP_HOST: 'mail.example', SMTP_PASS: 'smtp-SECRET-5',
  SMTP_USER_1: 'a@x.co', SMTP_USER_2: 'b@x.co', SMTP_USER_3: 'c@x.co', VAPID_PUBLIC_KEY: 'vp', VAPID_PRIVATE_KEY: 'vapid-SECRET-6', GROQ_API_KEY: 'groq-SECRET-7', CRON_SECRET: 'cron-SECRET-8', BIOMETRIC_API_KEY: 'bio-SECRET-9' };
const state = (checks, id) => (checks.find(c => c.id === id) || {}).state;

test('settings: present, missing, short and optional — and no value ever appears', () => {
  const all = H.configChecks(SECRETS);
  assert.ok(all.every(c => c.state === 'ok' || c.state === 'off'), JSON.stringify(all.filter(c => c.state !== 'ok')));
  const text = JSON.stringify(all);
  for (const v of Object.values(SECRETS)) if (/SECRET/.test(v)) assert.equal(text.includes(v), false, 'leaked ' + v);
  const none = H.configChecks({});
  assert.equal(state(none, 'SUPABASE_SERVICE_ROLE_KEY'), 'missing');
  assert.equal(state(none, 'mail'), 'missing');
  assert.equal(state(none, 'turn'), 'off', 'optional features are "not set up", not errors');
  assert.match(none.find(c => c.id === 'mail').fix, /SMTP_HOST, SMTP_PASS, MAIL_API_KEY/);
  assert.equal(state(H.configChecks({ ADMIN_PASSWORD: 'short' }), 'ADMIN_PASSWORD'), 'degraded');
  assert.equal(state(H.configChecks({ SMTP_USER_1: 'a@x.co' }), 'mail_senders'), 'degraded');
});

test('database: zero-row reads only; a missing migration names its file; the gate is checked', async () => {
  const calls = [];
  const request = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body });
    const reply = (status, body) => new Response(JSON.stringify(body), { status });
    if (url.includes('result_summary')) return reply(400, { code: '42703', message: 'column does not exist' });
    if (url.includes('/rpc/ws_access_control_status')) return reply(200, { tables_with_rls: 90, tables_gated: 89, storage_gated: true, pre_request: null, mfa_check: true, session_check: true, private_columns_hidden: true, pending_accounts: 2 });
    if (url.includes('/rpc/ws_published_leftovers')) return reply(200, ['a/file', 'b/file']);
    return reply(200, []);
  };
  const checks = await H.databaseChecks({ url: 'https://db', key: 'service-SECRET-2', request });
  assert.equal(state(checks, 'migration_20'), 'missing');
  assert.match(checks.find(c => c.id === 'migration_20').fix, /supabase-task-completion-migration\.sql/);
  assert.equal(state(checks, 'migration_16'), 'ok');
  const gate = checks.find(c => c.id === 'access_gate');
  assert.equal(gate.state, 'degraded');
  assert.match(gate.fix, /1 table\(s\) without the gate/);
  assert.match(gate.fix, /pre-request/);
  assert.equal(state(checks, 'published_leftovers'), 'degraded');
  // Every request is a GET with limit=0, or a function that reads.
  for (const c of calls) {
    if (c.method === 'GET') assert.match(c.url, /limit=0$/);
    else assert.match(c.url, /rpc\/(crm_lead_summary|ws_access_control_status|ws_published_leftovers)$/);
  }
  assert.equal(JSON.stringify(checks).includes('service-SECRET-2'), false);
});
