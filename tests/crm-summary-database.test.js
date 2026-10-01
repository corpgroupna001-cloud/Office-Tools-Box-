// supabase-crm-summary-migration.sql (migration 19) on PGlite: dashboard and
// forecast totals computed by the database, per currency (BUG-04), over every
// row the caller may see rather than the first 1,000 (PERF-01).
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, as, makeUser, pglite } = require('./fixtures/load-db');

const skip = pglite() ? false : 'WS_SKIP_DB_TESTS=1: database tests skipped on purpose';
const NOVA = 'Nova Sportsmart Private Limited';
const JOBWAYS = 'Jobways Point LLP';

let db, M, A, B, pipe;
const q = async (uid, sql, params) => (await as(db, uid, () => db.query(sql, params))).rows;
const svc = async (sql, params) => (await db.query(sql, params)).rows;
const json = v => (typeof v === 'string' ? JSON.parse(v) : v);
const summary = async (uid, args = '') => json((await q(uid, `select public.crm_deal_summary(${args}) s`))[0].s);
const byCur = (s, c) => s.currencies.find(x => x.currency === c);

async function deal(uid, { title = 'Deal', value = 0, currency = 'INR', probability = 0, stage = 'open', closed = null, expected = null } = {}) {
  const r = await q(uid, `insert into crm_deals (title, owner_id, pipeline_id, stage_id, value, currency, probability, expected_close_date)
                          values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [title, uid, pipe.id, pipe[stage], value, currency, probability, expected]);
  // The stage sets a default probability; these tests want their own.
  await svc(`update crm_deals set probability = $2 where id = $1`, [r[0].id, probability]);
  if (closed) await svc(`update crm_deals set actual_close_date = $2 where id = $1`, [r[0].id, closed]);
  return r[0].id;
}

test.before(async () => {
  if (skip) return;
  db = await freshDb();
  M = await makeUser(db, { email: 'maya@nova.test', name: 'Maya', company: NOVA, role: 'manager' });
  A = await makeUser(db, { email: 'anil@nova.test', name: 'Anil', company: NOVA });
  B = await makeUser(db, { email: 'bala@jobways.test', name: 'Bala', company: JOBWAYS });
  const p = (await svc(`select id from crm_pipelines where is_default limit 1`))[0];
  const st = await svc(`select id, is_won, is_lost from crm_pipeline_stages where pipeline_id = $1 order by position`, [p.id]);
  pipe = { id: p.id, open: st.find(s => !s.is_won && !s.is_lost).id, won: st.find(s => s.is_won).id, lost: st.find(s => s.is_lost).id };
});

test('mixed currencies are never added together: INR 100 + USD 100 is not 200 of anything', { skip }, async () => {
  await deal(A, { title: 'Kit (INR)', value: 100, currency: 'INR', probability: 50 });
  await deal(A, { title: 'Kit (USD)', value: 100, currency: 'USD', probability: 20 });
  await deal(A, { title: 'Won in euros', value: 70, currency: 'EUR', stage: 'won', closed: '2026-09-15' });
  const s = await summary(A, `p_owner => '${A}', p_from => '2026-09-01', p_to => '2026-09-30'`);
  assert.deepEqual(s.currencies.map(c => c.currency).sort(), ['EUR', 'INR', 'USD']);
  assert.equal(byCur(s, 'INR').open_value, 100);
  assert.equal(byCur(s, 'USD').open_value, 100);
  assert.equal(byCur(s, 'INR').weighted_value, 50);
  assert.equal(byCur(s, 'USD').weighted_value, 20);
  assert.equal(byCur(s, 'EUR').won_value, 70, 'a won deal in a currency no open deal uses still shows, in its own currency');
  assert.equal(byCur(s, 'EUR').open_count, 0);
  assert.equal(byCur(s, 'INR').won_value, 0);
  assert.equal(s.open_count, 2);
  const stages = s.stages.filter(x => x.stage_id === pipe.open);
  assert.deepEqual(stages.map(x => [x.currency, x.count, x.value]).sort(), [['INR', 1, 100], ['USD', 1, 100]], 'stage bars are per currency too');
});

test('won and lost count only inside the period; all time without one', { skip }, async () => {
  await deal(M, { title: 'August win', value: 10, stage: 'won', closed: '2026-08-10' });
  await deal(M, { title: 'September loss', value: 20, stage: 'lost', closed: '2026-09-12' });
  const sept = await summary(M, `p_owner => '${M}', p_from => '2026-09-01', p_to => '2026-09-30'`);
  assert.equal(byCur(sept, 'INR').won_count, 0);
  assert.equal(byCur(sept, 'INR').lost_value, 20);
  const ever = await summary(M, `p_owner => '${M}'`);
  assert.equal(byCur(ever, 'INR').won_value, 10);
});

test('totals follow Row Level Security: another company sees none of these deals', { skip }, async () => {
  const s = await summary(B);
  assert.deepEqual(s.currencies, []);
  assert.equal(s.open_count, 0);
  await assert.rejects(as(db, null, async () => { await db.exec('set role anon'); try { await db.query(`select public.crm_deal_summary()`); } finally { await db.exec('reset role'); } }), /permission denied/);
});

test('more than 1,000 deals are all counted (the dashboard used to stop at the first page)', { skip }, async () => {
  const before = byCur(await summary(M), 'INR');
  await svc(`insert into crm_deals (title, owner_id, company, pipeline_id, stage_id, value, currency, status)
             select 'Bulk ' || g, $1, $2, $3, $4, 10, 'INR', 'open' from generate_series(1, 1500) g`, [M, NOVA, pipe.id, pipe.open]);
  const after = byCur(await summary(M), 'INR');
  assert.equal(after.open_count - before.open_count, 1500);
  assert.equal(Math.round(after.open_value - before.open_value), 15000);
});

test('lead summary: every status, and conversion among leads created in the period', { skip }, async () => {
  await svc(`insert into crm_leads (name, owner_id, company, status, created_at) select 'L' || g, $1, $2, 'new', '2026-09-05' from generate_series(1, 1200) g`, [A, NOVA]);
  await svc(`insert into crm_leads (name, owner_id, company, status, converted_at, created_at) values ('Won lead', $1, $2, 'converted', now(), '2026-09-06')`, [A, NOVA]);
  const s = json((await q(A, `select public.crm_lead_summary(p_owner => $1, p_from => '2026-09-01', p_to => '2026-10-01') s`, [A]))[0].s);
  assert.equal(s.by_status.new, 1200, 'not capped at 1,000');
  assert.equal(s.created, 1201);
  assert.equal(s.created_converted, 1);
  assert.equal(json((await q(B, `select public.crm_lead_summary() s`))[0].s).total, 0);
});

test('forecast: months, commit, overdue, people and win/loss in one currency', { skip }, async () => {
  const F = await makeUser(db, { email: 'fiona@nova.test', name: 'Fiona', company: NOVA });
  await deal(F, { value: 1000, currency: 'INR', probability: 80, expected: '2026-10-20' });   // commit + best case
  await deal(F, { value: 500, currency: 'INR', probability: 30, expected: '2026-10-25' });    // best case only
  await deal(F, { value: 999, currency: 'USD', probability: 90, expected: '2026-10-20' });    // other currency: ignored
  await deal(F, { value: 300, currency: 'INR', probability: 50, expected: '2026-07-01' });    // overdue
  await deal(F, { value: 200, currency: 'INR', probability: 50 });                            // no date: overdue
  await deal(F, { value: 400, currency: 'INR', stage: 'won', closed: '2026-10-03' });
  await deal(F, { value: 100, currency: 'INR', stage: 'lost', closed: '2026-09-20' });
  const r = json((await q(F, `select public.crm_forecast_summary(array['2026-10','2026-11','2026-12'], '2026-07-01', 'INR', $1) f`, [F]))[0].f);
  const oct = r.months[0];
  assert.deepEqual([oct.month, oct.closed, oct.commit, oct.bestCase, oct.pipeline], ['2026-10', 400, 1000, 1500, 950]);
  assert.deepEqual(r.months.map(m => m.month), ['2026-10', '2026-11', '2026-12']);
  assert.deepEqual(r.overdue, { count: 2, value: 500 });
  assert.deepEqual(r.people.map(p => [p.owner_id === F, p.closed, p.commit]), [[true, 400, 1000]]);
  assert.equal(r.win_loss.won, 1);
  assert.equal(r.win_loss.lost, 1);
  assert.deepEqual(r.win_loss.reasons.map(x => x.reason), ['No reason given']);
  const usd = json((await q(F, `select public.crm_forecast_summary(array['2026-10'], '2026-07-01', 'USD', $1) f`, [F]))[0].f);
  assert.equal(usd.months[0].commit, 999);
});
