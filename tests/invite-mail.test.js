// Inviting people by email: who may do it, what is sent, and that the request
// only picks the company and the addresses. No network: Supabase, SMTP and
// the audit log are stand-ins.
const test = require('node:test');
const assert = require('node:assert/strict');
const { emailInvite, buildInviteEmail, inviteLink, parseEmails, MAX } = require('../lib/invite-mail');

const URL_BASE = 'https://db.example.test';
const KEY = 'test-service-key';
const TOKEN = 'user-access-token';
const ORIGIN = 'https://worksuite.example';
const NOVA = 'Nova Sportsmart Private Limited';
const JOBWAYS = 'Jobways Point LLP';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function backend(state = {}) {
  const calls = [];
  const s = {
    user: { id: USER_ID }, userStatus: 200,
    profile: { id: USER_ID, full_name: 'Manager One', email: 'manager@nova.example', company: NOVA, company2: null, app_role: 'manager' },
    existing: [],
    ...state,
  };
  const reply = (status, body) => new Response(JSON.stringify(body ?? null), { status });
  const request = async (url, options = {}) => {
    const p = url.slice(URL_BASE.length);
    calls.push({ method: options.method || 'GET', path: p, headers: options.headers || {} });
    if (p === '/auth/v1/user') return s.userStatus === 200 ? reply(200, s.user) : reply(s.userStatus, { msg: 'invalid' });
    if (p.startsWith('/rest/v1/profiles?id=')) return reply(200, s.profile ? [s.profile] : []);
    if (p.startsWith('/rest/v1/profiles?email=')) return reply(200, s.existing);
    return reply(404, { message: 'unexpected ' + p });
  };
  const mails = [], audits = [];
  const deps = {
    url: URL_BASE, key: KEY, token: TOKEN, origin: ORIGIN, request,
    sendMail: async mail => {
      mails.push(mail);
      if (state.sendMail) return state.sendMail(mail);
      return { ok: true, messageId: '<m@test>', from: 'sender@nova.example' };
    },
    recordMail: async (meta, result) => { audits.push({ meta, result }); if (state.auditThrows) throw new Error('audit down'); return true; },
  };
  return { deps, calls, mails, audits };
}

const run = (b, body = { company: NOVA, emails: ['new.person@example.com'] }) => emailInvite(body, b.deps);
const rejectsWith = (promise, status, pattern) => assert.rejects(promise, e => e.status === status && (!pattern || pattern.test(e.message)));

/* ============================ Who may invite ============================ */

test('no token, or a token Supabase does not accept, is a 401 and nothing is sent', async () => {
  const b = backend();
  await rejectsWith(emailInvite({ company: NOVA, emails: ['a@b.co'] }, { ...b.deps, token: '' }), 401);
  const bad = backend({ userStatus: 401 });
  await rejectsWith(run(bad), 401, /Sign in again/);
  assert.equal(b.mails.length + bad.mails.length, 0);
  assert.equal(bad.calls[0].headers.Authorization, `Bearer ${TOKEN}`, 'the caller is identified by their own token');
});

test('an ordinary employee cannot invite people', async () => {
  const b = backend({ profile: { id: USER_ID, email: 'e@nova.example', company: NOVA, app_role: 'employee' } });
  await rejectsWith(run(b), 403, /Only managers/);
  assert.equal(b.mails.length, 0);
});

test('a manager invites to their own company (or their second one) only; an admin to any', async () => {
  const other = backend({ profile: { id: USER_ID, email: 'm@jobways.example', company: JOBWAYS, company2: null, app_role: 'manager' } });
  await rejectsWith(run(other), 403, /own company/);
  assert.equal(other.mails.length, 0);
  const dual = backend({ profile: { id: USER_ID, email: 'm@jobways.example', company: JOBWAYS, company2: NOVA, app_role: 'manager' } });
  assert.equal((await run(dual)).success, true);
  const admin = backend({ profile: { id: USER_ID, email: 'a@group.example', company: JOBWAYS, app_role: 'admin' } });
  assert.deepEqual((await run(admin)).sent, ['new.person@example.com']);
});

/* ============================ What is accepted ============================ */

test('a company without a mailbox, or not a company at all, is refused before any lookup', async () => {
  for (const company of ['Navyug Raise A Player Foundation', 'Evil Corp', '', undefined]) {
    const b = backend();
    await rejectsWith(run(b, { company, emails: ['a@b.co'] }), 400, /company/);
    assert.equal(b.calls.length, 0);
  }
});

test('bad addresses, none at all, or too many are refused before any lookup', async () => {
  const cases = [
    [{ company: NOVA, emails: ['ok@example.com', 'not-an-email'] }, /not an email address: not-an-email/],
    [{ company: NOVA, emails: ['a@b.co', 'x@y'] }, /not an email/],
    [{ company: NOVA, emails: ['"x"@evil.co'] }, /not an email/],
    [{ company: NOVA, emails: ['a@b.co)'] }, /not an email/],
    [{ company: NOVA, emails: [] }, /at least one/],
    [{ company: NOVA, emails: '  ' }, /at least one/],
    [{ company: NOVA, emails: Array.from({ length: MAX + 1 }, (_, i) => `p${i}@example.com`) }, new RegExp(`up to ${MAX}`)],
  ];
  for (const [body, pattern] of cases) {
    const b = backend();
    await rejectsWith(run(b, body), 400, pattern);
    assert.equal(b.calls.length, 0);
  }
});

test('addresses may be a list or text; case and repeats collapse', () => {
  assert.deepEqual(parseEmails('A@Example.com, b@example.com;\na@example.com  c@example.com'), { valid: ['a@example.com', 'b@example.com', 'c@example.com'], invalid: [] });
  assert.deepEqual(parseEmails(['X@Y.co', 'x@y.co', null, '']).valid, ['x@y.co']);
});

test('an origin that is not a plain web address is a server error, not a strange link', async () => {
  for (const origin of ['', 'javascript:alert(1)', 'https://evil.example/path', 'https://a.example"><script>']) {
    const b = backend();
    await rejectsWith(emailInvite({ company: NOVA, emails: ['a@b.co'] }, { ...b.deps, origin }), 500);
    assert.equal(b.mails.length, 0);
  }
});

/* ============================ What is sent ============================ */

test('each person gets their own message with a sign-up link for them; the reply goes to the manager', async () => {
  const b = backend();
  const out = await run(b, { company: NOVA, emails: ['One@Example.com', 'two@example.com'] });
  assert.deepEqual(out, { success: true, sent: ['one@example.com', 'two@example.com'], existing: [], failed: [] });
  assert.equal(b.mails.length, 2);
  for (const m of b.mails) {
    assert.ok(!m.to.includes(','), 'one address per message');
    assert.equal(m.company, NOVA, 'sent from the company mailbox');
    assert.equal(m.replyTo, 'manager@nova.example');
    assert.match(m.subject, /Manager One invited you to WorkSuite/);
    const link = inviteLink(ORIGIN, NOVA, m.to);
    assert.ok(m.text.includes(link));
    assert.ok(m.html.includes(link.replace(/&/g, '&amp;')));
  }
  const url = new URL(inviteLink(ORIGIN, NOVA, 'one@example.com'));
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.searchParams.get('signup'), '1');
  assert.equal(url.searchParams.get('company'), NOVA);
  assert.equal(url.searchParams.get('email'), 'one@example.com');
});

test('people who already have an account are skipped and reported', async () => {
  const b = backend({ existing: [{ email: 'Known@Example.com' }] });
  const out = await run(b, { company: NOVA, emails: ['known@example.com', 'new@example.com'] });
  assert.deepEqual(out.existing, ['known@example.com']);
  assert.deepEqual(out.sent, ['new@example.com']);
  assert.deepEqual(b.mails.map(m => m.to), ['new@example.com']);
  const lookup = b.calls.find(c => c.path.startsWith('/rest/v1/profiles?email='));
  assert.equal(lookup.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(decodeURIComponent(lookup.path), '/rest/v1/profiles?email=in.(known@example.com,new@example.com)&select=email');
});

test('when everyone already has an account nothing is sent and that is not an error', async () => {
  const b = backend({ existing: [{ email: 'known@example.com' }] });
  const out = await run(b, { company: NOVA, emails: ['known@example.com'] });
  assert.deepEqual(out, { success: true, sent: [], existing: ['known@example.com'], failed: [] });
  assert.equal(b.mails.length, 0);
});

test('the manager\'s name cannot inject markup', () => {
  const mail = buildInviteEmail({ inviter: '<img src=x onerror=alert(1)>', company: NOVA, link: 'https://w.example/?signup=1' });
  assert.ok(!mail.html.includes('<img'));
  assert.ok(mail.html.includes('&lt;img'));
});

test('every attempt is audited as an invitation; an audit outage does not stop the mail', async () => {
  const b = backend({ auditThrows: true });
  const out = await run(b, { company: NOVA, emails: ['a@example.com', 'b@example.com'] });
  assert.deepEqual(out.sent, ['a@example.com', 'b@example.com']);
  assert.deepEqual(b.audits.map(a => a.meta), [{ company: NOVA, to: 'a@example.com', category: 'invite' }, { company: NOVA, to: 'b@example.com', category: 'invite' }]);
});

test('some failures are reported; all failing is a clear error', async () => {
  const some = backend({ sendMail: m => (m.to.startsWith('bad') ? { ok: false, reason: 'smtp_send_failed' } : { ok: true }) });
  const out = await run(some, { company: NOVA, emails: ['bad@example.com', 'good@example.com'] });
  assert.deepEqual(out.sent, ['good@example.com']);
  assert.deepEqual(out.failed, ['bad@example.com']);

  await rejectsWith(run(backend({ sendMail: () => ({ ok: false, reason: 'smtp_not_configured' }) })), 502, /not configured/);
  await rejectsWith(run(backend({ sendMail: () => { throw new Error('socket'); } })), 502, /did not accept/);
});

test('invitations are audited under their own category', async () => {
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, fetch: global.fetch };
  const bodies = [];
  process.env.SUPABASE_URL = URL_BASE; process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
  global.fetch = async (u, o) => { bodies.push(JSON.parse(o.body)); return new Response(null, { status: 201 }); };
  try {
    const { recordMail } = require('../lib/mail-audit');
    assert.equal(await recordMail({ company: NOVA, to: 'a@example.com', category: 'invite' }, { ok: true }), true);
    assert.equal(bodies[0].category, 'invite');
  } finally {
    if (saved.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    global.fetch = saved.fetch;
  }
});
