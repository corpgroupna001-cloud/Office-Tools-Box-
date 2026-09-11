// The CRM migrations on a real Postgres engine (PGlite, in-process).
//
// Every migration runs in deployment order on a Supabase stand-in, the CRM
// set runs twice (it must be safe to re-run), and then the rules are checked
// the way the browser meets them: as signed-in employees, a manager and an
// admin, through Row Level Security and the triggers. Nothing here trusts the
// JavaScript UI — these are the database's own answers.
//
// Skips itself when the dev dependency is missing: npm i -D @electric-sql/pglite
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { freshDb, as, makeUser, pglite } = require('./fixtures/load-db');

const skip = pglite() ? false : 'PGlite is not installed (npm i -D @electric-sql/pglite)';
const NOVA = 'Nova Sportsmart Private Limited';
const JOBWAYS = 'Jobways Point LLP';
const RLS = /row-level security/;

let db, A, C, M, B, X;          // A, C employees of Nova (C reports to M); M Nova manager; B Jobways employee; X admin
const ids = {};

/** Query as a user; rows back. */
const q = async (uid, sql, params) => (await as(db, uid, () => db.query(sql, params))).rows;
/** Query as the service (no JWT, RLS bypassed as the table owner). */
const svc = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (uid, sql, params) => (await q(uid, sql, params))[0];
const json = v => (typeof v === 'string' ? JSON.parse(v) : v);
const TODAY = "(now() at time zone 'Asia/Kolkata')::date";

test.before(async () => {
  if (skip) return;
  db = await freshDb({ twice: true });
  M = await makeUser(db, { email: 'manager@nova.test', name: 'Maya Manager', company: NOVA, role: 'manager' });
  A = await makeUser(db, { email: 'anil@nova.test', name: 'Anil Kumar', company: NOVA });
  C = await makeUser(db, { email: 'chitra@nova.test', name: 'Chitra Rao', company: NOVA, manager_id: M });
  B = await makeUser(db, { email: 'bala@jobways.test', name: 'Bala J', company: JOBWAYS });
  X = await makeUser(db, { email: 'admin@nova.test', name: 'Asha Admin', company: NOVA, role: 'admin' });
});

test('every migration applies on Postgres, the CRM set re-runs cleanly, and every public table has RLS', { skip }, async () => {
  const noRls = await svc(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                            where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
  assert.deepEqual(noRls.map(r => r.relname), []);
  const tables = (await svc(`select table_name from information_schema.tables where table_schema = 'public'`)).map(r => r.table_name);
  for (const t of ['crm_contacts', 'crm_leads', 'crm_deals', 'tasks', 'projects', 'documents', 'calendar_events', 'invoices', 'conversations', 'notifications', 'crm_reminder_log']) {
    assert.ok(tables.includes(t), `${t} exists`);
  }
  const pipelines = await svc(`select count(*)::int n from crm_pipelines`);
  assert.equal(pipelines[0].n, 1, 'the default pipeline is seeded once, not once per run');
});

test('records are stamped with their creator and company, and stay inside that company', { skip }, async () => {
  const c = await one(A, `insert into crm_contacts (first_name, last_name, email, phone) values ('Ravi', 'Shah', 'ravi@example.com', '+91 98765 43210')
                          returning id, company, created_by`);
  ids.contact = c.id;
  assert.equal(c.company, NOVA);
  assert.equal(c.created_by, A);
  assert.equal((await q(C, `select id from crm_contacts where id = $1`, [c.id])).length, 1, 'a colleague in the same company sees it');
  assert.equal((await q(X, `select id from crm_contacts where id = $1`, [c.id])).length, 1, 'an admin sees it');
  assert.equal((await q(B, `select id from crm_contacts where id = $1`, [c.id])).length, 0, 'another company does not');
  await assert.rejects(q(B, `insert into crm_contacts (first_name, company) values ('Sneak', $1)`, [NOVA]), RLS, 'nobody writes into another company');
});

test('only the owner, the creator or a manager can change a record; only managers delete', { skip }, async () => {
  assert.equal((await q(C, `update crm_contacts set job_title = 'CEO' where id = $1 returning id`, [ids.contact])).length, 0, 'a colleague cannot edit it');
  assert.equal((await q(A, `update crm_contacts set job_title = 'Buyer' where id = $1 returning id`, [ids.contact])).length, 1, 'the creator can');
  assert.equal((await q(M, `update crm_contacts set job_title = 'Head Buyer' where id = $1 returning id`, [ids.contact])).length, 1, 'a manager can');
  const tmp = await one(A, `insert into crm_contacts (first_name) values ('Temp') returning id`);
  assert.equal((await q(A, `delete from crm_contacts where id = $1 returning id`, [tmp.id])).length, 0, 'an employee cannot delete');
  assert.equal((await q(M, `delete from crm_contacts where id = $1 returning id`, [tmp.id])).length, 1, 'a manager can');
});

test('nobody can promote themselves; the admin console (service key) can', { skip }, async () => {
  await assert.rejects(q(A, `update profiles set app_role = 'admin' where id = $1`, [A]), /app_role can only be changed by an administrator/);
  await svc(`update profiles set app_role = 'manager' where id = $1`, [A]);
  assert.equal((await svc(`select app_role from profiles where id = $1`, [A]))[0].app_role, 'manager');
  await svc(`update profiles set app_role = 'employee' where id = $1`, [A]);
  const own = await q(A, `update profiles set full_name = 'Anil K' where id = $1 returning full_name`, [A]);
  assert.equal(own[0].full_name, 'Anil K', 'people still edit their own name');
});

test('converting a lead links the matching contact instead of duplicating it, and creates the deal', { skip }, async () => {
  const lead = await one(A, `insert into crm_leads (name, organization, email, estimated_value, owner_id) values ('Ravi Shah', 'Acme Sports', 'RAVI@example.com', 50000, $1) returning id`, [A]);
  ids.lead = lead.id;
  const res = json((await one(A, `select public.crm_convert_lead($1::uuid) as r`, [lead.id])).r);
  assert.equal(res.contact_id, ids.contact, 'the existing contact (same email, different case) is linked');
  assert.equal(res.existing_contact, true);
  assert.ok(res.deal_id);
  ids.deal = res.deal_id;
  const l = await one(A, `select status, converted_contact_id, converted_deal_id from crm_leads where id = $1`, [lead.id]);
  assert.deepEqual([l.status, l.converted_contact_id, l.converted_deal_id], ['converted', ids.contact, ids.deal], 'the lead keeps its history');
  const d = await one(A, `select d.value::int v, d.owner_id, d.contact_id, s.name stage from crm_deals d join crm_pipeline_stages s on s.id = d.stage_id where d.id = $1`, [ids.deal]);
  assert.deepEqual([d.v, d.owner_id, d.contact_id, d.stage], [50000, A, ids.contact, 'New Opportunity']);
  const acts = (await q(A, `select action from crm_activities where lead_id = $1`, [lead.id])).map(r => r.action);
  assert.ok(acts.includes('lead.created') && acts.includes('lead.converted') && acts.includes('deal.created'), acts.join(','));
  await assert.rejects(q(A, `select public.crm_convert_lead($1::uuid)`, [lead.id]), /already converted/);
  const other = await one(A, `insert into crm_leads (name) values ('Someone else') returning id`);
  await assert.rejects(q(C, `select public.crm_convert_lead($1::uuid)`, [other.id]), /Only the lead owner or a manager/);
});

test('moving a deal to Won closes it, logs the move, and tells the owner', { skip }, async () => {
  const won = await one(M, `select id from crm_pipeline_stages where is_won limit 1`);
  const d = await one(M, `update crm_deals set stage_id = $1 where id = $2 returning status, probability, actual_close_date::text closed`, [won.id, ids.deal]);
  assert.equal(d.status, 'won');
  assert.equal(d.probability, 100);
  assert.equal(d.closed, (await svc(`select ${TODAY}::text t`))[0].t, 'closed on today’s IST date');
  const moves = await q(A, `select meta->>'from' f, meta->>'to' t from crm_activities where deal_id = $1 and action = 'deal.stage_changed'`, [ids.deal]);
  assert.deepEqual(moves[0], { f: 'New Opportunity', t: 'Won' });
  assert.ok((await q(A, `select kind from notifications where user_id = $1 and kind = 'deal.won'`, [A])).length, 'the owner is notified');
  assert.equal((await q(C, `select id from notifications where user_id = $1`, [A])).length, 0, 'nobody reads another person’s notifications');
  const other = await one(M, `insert into crm_pipelines (name, company) values ('Renewals', $1) returning id`, [NOVA]);
  const st = await one(M, `insert into crm_pipeline_stages (pipeline_id, name, position) values ($1, 'Open', 1) returning id`, [other.id]);
  await assert.rejects(q(M, `update crm_deals set stage_id = $1 where id = $2`, [st.id, ids.deal]), /does not belong/);
});

test('the activity timeline is append-only and written as yourself', { skip }, async () => {
  assert.equal((await q(A, `update crm_activities set action = 'x' returning id`)).length, 0);
  assert.equal((await q(A, `delete from crm_activities returning id`)).length, 0);
  await assert.rejects(q(A, `insert into crm_activities (actor_id, action, entity_type, entity_id) values ($1, 'note.added', 'contact', $2)`, [C, ids.contact]), RLS);
});

test('assigning a task notifies the assignee; completing and reopening follow the status', { skip }, async () => {
  const t = await one(A, `insert into tasks (title, assignee_id, deal_id, contact_id, due_date) values ('Send proposal', $1, $2, $3, ${TODAY}) returning id`, [C, ids.deal, ids.contact]);
  ids.task = t.id;
  assert.ok((await q(C, `select id from notifications where user_id = $1 and kind = 'task.assigned' and entity_id = $2`, [C, t.id])).length);
  assert.equal((await q(B, `select id from tasks where id = $1`, [t.id])).length, 0, 'another company cannot see it');
  const done = await one(C, `update tasks set status = 'completed' where id = $1 returning completed_at is not null as done`, [t.id]);
  assert.equal(done.done, true);
  assert.ok((await q(A, `select id from notifications where user_id = $1 and kind = 'task.completed'`, [A])).length, 'the creator hears it is done');
  const reopened = await one(C, `update tasks set status = 'todo' where id = $1 returning completed_at`, [t.id]);
  assert.equal(reopened.completed_at, null);
  assert.equal((await q(B, `update tasks set title = 'x' where id = $1 returning id`, [t.id])).length, 0);
});

test('a project gets its own board, members are told, and members can work on it', { skip }, async () => {
  const p = await one(A, `insert into projects (name, owner_id) values ('Kit delivery', $1) returning id`, [A]);
  ids.project = p.id;
  const board = (await one(A, `select board_id from projects where id = $1`, [p.id])).board_id;
  assert.ok(board, 'the board is created automatically');
  const cols = await q(A, `select name, maps_to_status from board_columns where board_id = $1 order by position`, [board]);
  assert.deepEqual(cols.map(c => c.maps_to_status), ['todo', 'in_progress', 'blocked', 'review', 'completed']);
  await q(A, `insert into project_members (project_id, user_id, added_by) values ($1, $2, $3)`, [p.id, C, A]);
  assert.ok((await q(C, `select id from notifications where user_id = $1 and kind = 'project.added'`, [C])).length);
  assert.equal((await q(C, `update projects set description = 'Phase 1' where id = $1 returning id`, [p.id])).length, 1, 'a member may edit the project');
  const review = await one(C, `select id from board_columns where board_id = $1 and maps_to_status = 'review'`, [board]);
  const card = await one(C, `insert into tasks (title, project_id, board_id, board_column_id) values ('Pack boxes', $1, $2, $3) returning status, company`, [p.id, board, review.id]);
  assert.deepEqual([card.status, card.company], ['review', NOVA], 'dropping into a column sets the status it maps to');
  assert.equal((await q(B, `select id from projects where id = $1`, [p.id])).length, 0);
});

test('invoices: managers only, totals owned by the database, payments bounded by the balance', { skip }, async () => {
  await assert.rejects(q(A, `insert into invoices (bill_to_name) values ('Acme')`), RLS, 'employees cannot raise invoices');
  const inv = await one(M, `insert into invoices (bill_to_name, contact_id, invoice_date, due_date, subtotal, total)
                            values ('Acme Sports', $1, ${TODAY}, ${TODAY} + 15, 999999, 999999) returning id, invoice_number, total::text`, [ids.contact]);
  ids.invoice = inv.id;
  assert.match(inv.invoice_number, /^INV-\d{4}-0001$/);
  assert.equal(inv.total, '0.00', 'a client-sent total is ignored');
  await q(M, `insert into invoice_items (invoice_id, position, description, quantity, unit_price, tax_rate) values ($1, 1, 'Jerseys', 2, 500, 18)`, [inv.id]);
  await q(M, `insert into invoice_items (invoice_id, position, description, quantity, unit_price, discount_pct) values ($1, 2, 'Setup', 1, 1000, 50)`, [inv.id]);
  const t = await one(M, `select subtotal::text s, discount_total::text d, tax_total::text x, total::text t, balance::text b from invoices where id = $1`, [inv.id]);
  assert.deepEqual(t, { s: '2000.00', d: '500.00', x: '180.00', t: '1680.00', b: '1680.00' });
  assert.equal((await one(M, `update invoices set total = 1 where id = $1 returning total::text t`, [inv.id])).t, '1680.00', 'totals cannot be overwritten');
  await assert.rejects(q(M, `insert into invoice_payments (invoice_id, amount) values ($1, 100)`, [inv.id]), /sent invoice/);
  await q(M, `update invoices set status = 'sent' where id = $1`, [inv.id]);
  await assert.rejects(q(M, `update invoice_items set unit_price = 1 where invoice_id = $1`, [inv.id]), /while the invoice is a draft/);
  await assert.rejects(q(M, `insert into invoice_payments (invoice_id, amount) values ($1, 2000)`, [inv.id]), /exceeds the outstanding balance/);
  await q(M, `insert into invoice_payments (invoice_id, amount, method) values ($1, 680, 'UPI')`, [inv.id]);
  let s = await one(M, `select status, amount_paid::text p, balance::text b from invoices where id = $1`, [inv.id]);
  assert.deepEqual(s, { status: 'partially_paid', p: '680.00', b: '1000.00' });
  await q(M, `insert into invoice_payments (invoice_id, amount) values ($1, 1000)`, [inv.id]);
  s = await one(M, `select status, balance::text b, paid_at is not null paid from invoices where id = $1`, [inv.id]);
  assert.deepEqual(s, { status: 'paid', b: '0.00', paid: true });
  assert.equal((await q(A, `select id from invoices`)).length, 0, 'employees do not see invoices');
  assert.equal((await q(B, `select id from invoices`)).length, 0);

  const dup = (await one(M, `select public.invoice_duplicate($1::uuid) as id`, [inv.id])).id;
  const d = await one(M, `select status, invoice_number, (select count(*)::int from invoice_items where invoice_id = i.id) n from invoices i where id = $1`, [dup]);
  assert.deepEqual([d.status, d.n], ['draft', 2]);
  assert.match(d.invoice_number, /-0002$/);

  const empty = await one(M, `insert into invoices (bill_to_name, invoice_date) values ('Empty', ${TODAY}) returning id`);
  await assert.rejects(q(M, `update invoices set status = 'sent' where id = $1`, [empty.id]), /at least one line/);
  await q(M, `insert into invoice_items (invoice_id, description, quantity, unit_price) values ($1, 'Item', 1, 10)`, [empty.id]);
  await q(M, `update invoices set status = 'sent' where id = $1`, [empty.id]);
  assert.equal((await one(M, `update invoices set status = 'paid' where id = $1 returning status`, [empty.id])).status, 'sent', 'paid is earned by payments, not typed in');
});

test('private meetings stay with the organiser and invitees; invitations arrive', { skip }, async () => {
  const ev = await one(A, `insert into calendar_events (title, starts_at, ends_at, owner_id, visibility) values ('1:1', now() + interval '1 hour', now() + interval '2 hours', $1, 'private') returning id`, [A]);
  await q(A, `insert into event_participants (event_id, user_id) values ($1, $2)`, [ev.id, M]);
  assert.equal((await q(C, `select id from calendar_events where id = $1`, [ev.id])).length, 0, 'a colleague who is not invited cannot see it');
  assert.equal((await q(M, `select id from calendar_events where id = $1`, [ev.id])).length, 1, 'the invitee can');
  assert.equal((await q(X, `select id from calendar_events where id = $1`, [ev.id])).length, 1, 'an admin can');
  assert.ok((await q(M, `select id from notifications where user_id = $1 and kind = 'event.invited'`, [M])).length);
  assert.equal((await q(M, `update event_participants set response = 'accepted' where event_id = $1 and user_id = $2 returning response`, [ev.id, M])).length, 1);
  await assert.rejects(q(C, `insert into event_participants (event_id, user_id) values ($1, $2)`, [ev.id, C]), RLS);
  const pub = await one(A, `insert into calendar_events (title, starts_at, ends_at, owner_id) values ('Team sync', now(), now() + interval '30 minutes', $1) returning id`, [A]);
  assert.equal((await q(C, `select id from calendar_events where id = $1`, [pub.id])).length, 1, 'company events are visible to the company');
});

test('documents live in the uploader’s own folder and are readable only through their row', { skip }, async () => {
  await assert.rejects(q(A, `insert into documents (name, storage_path) values ('x.pdf', $1)`, [`${C}/x.pdf`]), RLS, 'no filing into someone else’s folder');
  await q(A, `insert into storage.objects (bucket_id, name) values ('documents', $1)`, [`${A}/quote.pdf`]);
  await assert.rejects(q(A, `insert into storage.objects (bucket_id, name) values ('documents', $1)`, [`${C}/quote.pdf`]), RLS);
  assert.equal((await q(C, `select id from storage.objects where name = $1`, [`${A}/quote.pdf`])).length, 0, 'no metadata row yet: private to the uploader');
  const doc = await one(A, `insert into documents (name, storage_path, mime_type, size_bytes) values ('Quote.pdf', $1, 'application/pdf', 1200) returning id`, [`${A}/quote.pdf`]);
  await q(A, `insert into document_links (document_id, entity_type, entity_id, created_by) values ($1, 'project', $2, $3)`, [doc.id, ids.project, A]);
  assert.equal((await q(C, `select id from storage.objects where name = $1`, [`${A}/quote.pdf`])).length, 1, 'the company can read it once it is a document');
  assert.equal((await q(B, `select id from storage.objects where name = $1`, [`${A}/quote.pdf`])).length, 0, 'another company cannot');
  assert.equal((await q(C, `select document_id from document_links where entity_type = 'project' and entity_id = $1`, [ids.project])).length, 1, 'it shows on the project');
});

test('managers read their people’s attendance and leave; colleagues do not; salaries stay private', { skip }, async () => {
  await svc(`insert into attendance_logs (user_id, employee_code, direction, log_datetime, log_date, device_sn) values ($1, 'E100', 'IN', now(), ${TODAY}, '')`, [C]);
  assert.equal((await q(C, `select id from attendance_logs where user_id = $1`, [C])).length, 1, 'own punches, as before');
  assert.equal((await q(M, `select id from attendance_logs where user_id = $1`, [C])).length, 1, 'the manager sees them');
  assert.equal((await q(A, `select id from attendance_logs where user_id = $1`, [C])).length, 0, 'a colleague does not');
  assert.equal((await q(B, `select id from attendance_logs where user_id = $1`, [C])).length, 0);
  await q(C, `insert into leave_requests (user_id, start_date, end_date) values ($1, ${TODAY} + 3, ${TODAY} + 4)`, [C]);
  assert.equal((await q(M, `select id from leave_requests where user_id = $1`, [C])).length, 1);
  assert.equal((await q(A, `select id from leave_requests where user_id = $1`, [C])).length, 0);
  await svc(`insert into salaries (user_id, per_day_rate) values ($1, 1500)`, [C]);
  assert.equal((await q(M, `select user_id from salaries`)).length, 0, 'not even a manager reads pay');
  assert.equal((await q(X, `select user_id from salaries`)).length, 0, 'nor a workspace admin: pay is the admin console’s alone');
});

test('group messages are for members only, authors alone edit, and DMs work as before', { skip }, async () => {
  const conv = await one(A, `insert into conversations (name) values ('Sales') returning id`);
  await q(A, `insert into conversation_members (conversation_id, user_id, added_by) values ($1, $2, $3)`, [conv.id, C, A]);
  assert.ok((await q(C, `select id from notifications where user_id = $1 and kind = 'conversation.added'`, [C])).length);
  const msg = await one(C, `insert into messages (sender_id, conversation_id, body) values ($1, $2, 'hello team') returning id`, [C, conv.id]);
  await assert.rejects(q(B, `insert into messages (sender_id, conversation_id, body) values ($1, $2, 'spam')`, [B, conv.id]), RLS, 'a non-member cannot post into the group');
  assert.equal((await q(B, `select id from messages where conversation_id = $1`, [conv.id])).length, 0);
  assert.equal((await q(M, `select id from messages where conversation_id = $1`, [conv.id])).length, 0, 'being a manager does not open other people’s groups');
  await assert.rejects(q(A, `update messages set body = 'changed' where id = $1`, [msg.id]), /Only the author/);
  const pin = await one(A, `update messages set pinned_at = now(), deleted_at = now() where id = $1 returning pinned_by, deleted_at`, [msg.id]);
  assert.equal(pin.pinned_by, A, 'members may pin');
  assert.equal(pin.deleted_at, null, 'but not mark someone else’s message deleted');
  assert.ok((await one(C, `update messages set body = 'hello everyone' where id = $1 returning edited_at`, [msg.id])).edited_at, 'the author may edit');
  const unread = await one(A, `select * from public.ws_unread_counts()`);
  assert.equal(Number(unread.group_unread), 1);

  const dm = await one(A, `insert into messages (sender_id, recipient_id, body) values ($1, $2, 'direct hello') returning id`, [A, C]);
  assert.equal((await q(C, `select id from messages where id = $1`, [dm.id])).length, 1);
  assert.equal((await q(B, `select id from messages where id = $1`, [dm.id])).length, 0);
  await assert.rejects(q(B, `insert into message_reactions (message_id, user_id, emoji) values ($1, $2, '👍')`, [dm.id, B]), RLS, 'no reacting to messages you cannot see');
  await q(C, `insert into message_reactions (message_id, user_id, emoji) values ($1, $2, '👍')`, [dm.id, C]);
  await assert.rejects(q(A, `insert into messages (sender_id, recipient_id, conversation_id, body) values ($1, $2, $3, 'both')`, [A, C, conv.id]), /messages_target_ck/);
});

test('a browser can notify a colleague only as itself', { skip }, async () => {
  await assert.rejects(q(A, `insert into notifications (user_id, actor_id, kind, title) values ($1, $1, 'mention', 'x')`, [C]), RLS);
  await assert.rejects(q(A, `insert into notifications (user_id, actor_id, kind, title) values ($1, $1, 'mention', 'x')`, [A]), RLS);
  await q(A, `insert into notifications (user_id, actor_id, kind, title) values ($1, $2, 'mention', 'Anil mentioned you')`, [C, A]);
});

test('server reminders fire once each, in their windows, and only the service may run them', { skip }, async () => {
  const P = '2026-09-11T10:00:00+05:30';                // a fixed "now": 10:00 IST
  const t = await one(A, `insert into tasks (title, assignee_id, due_date, reminder_at) values ('Call Acme', $1, '2026-09-11', $2::timestamptz - interval '1 minute') returning id`, [C, P]);
  const ev = await one(A, `insert into calendar_events (title, starts_at, ends_at, owner_id, reminder_minutes) values ('Review', $2::timestamptz + interval '10 minutes', $2::timestamptz + interval '40 minutes', $1, 30) returning id`, [A, P]);
  await q(A, `insert into event_participants (event_id, user_id) values ($1, $2)`, [ev.id, M]);
  await q(A, `insert into event_participants (event_id, user_id, response) values ($1, $2, 'declined')`, [ev.id, C]).catch(() => {});
  const lead = await one(A, `insert into crm_leads (name, owner_id, next_follow_up_at) values ('Follow me', $1, $2::timestamptz - interval '5 minutes') returning id`, [A, P]);
  const inv = await one(M, `insert into invoices (bill_to_name, invoice_date, due_date) values ('Late Ltd', '2026-09-01', '2026-09-10') returning id`);
  await q(M, `insert into invoice_items (invoice_id, description, quantity, unit_price) values ($1, 'Kit', 1, 100)`, [inv.id]);
  await q(M, `update invoices set status = 'sent' where id = $1`, [inv.id]);
  await svc(`update invoices set status = 'sent' where id = $1`, [inv.id]);   // as if it had been sent on time

  await assert.rejects(q(A, `select public.crm_run_reminders()`), /permission denied/, 'employees cannot trigger reminders');

  const first = json((await svc(`select public.crm_run_reminders($1::timestamptz) r`, [P]))[0].r);
  assert.equal(first.tasks, 1);
  assert.equal(first.events, 2, 'organiser and the invitee who has not declined');
  assert.equal(first.leads, 1);
  assert.ok(first.digests >= 1, 'a digest for everyone with work due');
  assert.equal(first.invoices, 1);
  assert.ok((await q(C, `select id from notifications where user_id = $1 and kind = 'task.reminder' and entity_id = $2`, [C, t.id])).length);
  assert.ok((await q(M, `select title from notifications where user_id = $1 and kind = 'event.reminder'`, [M]))[0].title.startsWith('At 10:10 am: Review'));
  assert.equal((await q(C, `select id from notifications where user_id = $1 and kind = 'event.reminder'`, [C])).length, 0, 'declined means no reminder');
  assert.ok((await q(A, `select id from notifications where user_id = $1 and kind = 'lead.follow_up' and entity_id = $2`, [A, lead.id])).length);
  assert.ok((await q(M, `select id from notifications where user_id = $1 and kind = 'invoice.overdue'`, [M])).length);
  assert.equal((await q(C, `select title from notifications where user_id = $1 and kind = 'task.digest'`, [C]))[0].title.includes('due today'), true);

  const again = json((await svc(`select public.crm_run_reminders($1::timestamptz) r`, [P]))[0].r);
  assert.deepEqual([again.tasks, again.events, again.leads, again.digests, again.invoices], [0, 0, 0, 0, 0], 'nothing fires twice');

  const early = json((await svc(`select public.crm_run_reminders($1::timestamptz) r`, ['2026-09-12T08:00:00+05:30']))[0].r);
  assert.equal(early.digests, 0, 'the next day’s digest waits until 09:00 IST');
});

test('the optional demo seed runs once and marks everything it creates', { skip }, async () => {
  const seed = fs.readFileSync(path.join(__dirname, '..', 'supabase-crm-demo-seed.sql'), 'utf8');
  await db.exec(seed);
  await db.exec(seed);
  const n = (await svc(`select count(*)::int n from crm_contacts where 'demo' = any(tags)`))[0].n;
  assert.equal(n, 1);
});
