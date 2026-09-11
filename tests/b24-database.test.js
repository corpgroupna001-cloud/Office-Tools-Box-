// supabase-b24-migration.sql on a real Postgres engine (PGlite): the company
// structure, the access-permissions matrix, customer companies, custom fields,
// products, automation, project privacy, the feed, whiteboards and the drive.
// Every check runs as a signed-in person through RLS and the triggers.
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
const B24 = fs.readFileSync(path.join(__dirname, '..', 'supabase-b24-migration.sql'), 'utf8');

let db, M, A, C, D, B, X;      // M Nova manager; A, C Nova Sales; D Nova Support (under Sales); B Jobways; X admin
const ids = {};

const q = async (uid, sql, params) => (await as(db, uid, () => db.query(sql, params))).rows;
const svc = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (uid, sql, params) => (await q(uid, sql, params))[0];
const json = v => (typeof v === 'string' ? JSON.parse(v) : v);
const names = rows => rows.map(r => r.name).sort();
async function anon(sql, params) {
  await db.exec('set role anon');
  try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); }
}
async function setLevel(role, entity, action, level, pipeline = null) {
  const r = (await svc(`select id from crm_roles where name = $1`, [role]))[0].id;
  await q(X, `insert into crm_role_permissions (role_id, entity, pipeline_id, action, level) values ($1, $2, $3, $4, $5)
              on conflict (role_id, entity, coalesce(pipeline_id::text, '*'), action) do update set level = excluded.level`,
    [r, entity, pipeline, action, level]);
}

test.before(async () => {
  if (skip) return;
  db = await freshDb({ twice: true });
  M = await makeUser(db, { email: 'maya@nova.test', name: 'Maya Manager', company: NOVA, role: 'manager' });
  A = await makeUser(db, { email: 'anil@nova.test', name: 'Anil Kumar', company: NOVA });
  C = await makeUser(db, { email: 'chitra@nova.test', name: 'Chitra Rao', company: NOVA });
  D = await makeUser(db, { email: 'dev@nova.test', name: 'Dev Singh', company: NOVA });
  B = await makeUser(db, { email: 'bala@jobways.test', name: 'Bala J', company: JOBWAYS });
  X = await makeUser(db, { email: 'admin@nova.test', name: 'Asha Admin', company: NOVA, role: 'admin' });
  await svc(`update profiles set department = 'Sales' where id in ($1, $2)`, [A, C]);
  await svc(`update profiles set department = 'Support' where id = $1`, [D]);
});

test('roles are seeded once, and every table the file adds has RLS', { skip }, async () => {
  const roles = await svc(`select name, is_system from crm_roles order by name`);
  assert.deepEqual(roles.map(r => r.name), ['Employee', 'Manager'], 'two runs, one set of roles');
  assert.equal((await svc(`select count(*)::int n from crm_role_permissions`))[0].n, 120);
  assert.equal((await svc(`select count(*)::int n from crm_role_assignments`))[0].n, 2);
  const noRls = await svc(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                            where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
  assert.deepEqual(noRls, []);
  assert.equal((await q(A, `update crm_role_permissions set level = 'all' returning id`)).length, 0, 'employees cannot edit the matrix');
  await assert.rejects(q(M, `insert into crm_roles (name) values ('Mine')`), RLS, 'nor can managers: roles are an admin setting');
});

test('the company structure seeds once from profiles; a department cannot sit inside itself', { skip }, async () => {
  await db.exec(B24);                     // people exist now: the seed runs
  await db.exec(B24);                     // and only once
  const depts = await svc(`select d.name, p.name parent, d.company from departments d left join departments p on p.id = d.parent_id order by d.name`);
  assert.deepEqual(depts.map(d => [d.name, d.parent]), [
    ['Corporate Group', null], [JOBWAYS, 'Corporate Group'], [NOVA, 'Corporate Group'], ['Sales', NOVA], ['Support', NOVA]]);
  const members = await svc(`select d.name, p.full_name from department_members m join departments d on d.id = m.department_id
                              join profiles p on p.id = m.user_id order by 2`);
  const where = Object.fromEntries(members.map(m => [m.full_name, m.name]));
  assert.equal(where['Anil Kumar'], 'Sales');
  assert.equal(where['Dev Singh'], 'Support');
  assert.equal(where['Maya Manager'], NOVA, 'people with no department sit in their company');
  assert.equal(where['Bala J'], JOBWAYS);
  for (const r of await svc(`select id, name from departments`)) ids[r.name] = r.id;

  // Support becomes a sub-department of Sales for the permission tests below.
  await q(M, `update departments set parent_id = $1 where id = $2`, [ids.Sales, ids.Support]);
  await assert.rejects(q(M, `update departments set parent_id = $1 where id = $2`, [ids.Support, ids.Sales]), /own sub-department/);
  await assert.rejects(q(A, `insert into departments (name, parent_id, company) values ('Rogue', $1, $2)`, [ids.Sales, NOVA]), RLS);
  assert.deepEqual(names(await q(B, `select name from departments`)), ['Corporate Group', JOBWAYS], 'another company’s structure stays private');
  assert.equal((await q(A, `select * from department_members where department_id = $1`, [ids[JOBWAYS]])).length, 0);
});

test('the access matrix: own, department, sub-departments and all, enforced by the database', { skip }, async () => {
  const la = await one(A, `insert into crm_leads (name, owner_id) values ('Lead of Anil', $1) returning id, number`, [A]);
  const lc = await one(C, `insert into crm_leads (name, owner_id) values ('Lead of Chitra', $1) returning id, number`, [C]);
  await one(D, `insert into crm_leads (name, owner_id) values ('Lead of Dev', $1) returning id`, [D]);
  assert.equal(Number(lc.number), Number(la.number) + 1, 'records are numbered in order');
  const seen = async uid => (await q(uid, `select name from crm_leads where name like 'Lead of %' order by name`)).map(r => r.name);

  assert.deepEqual(await seen(A), ['Lead of Anil', 'Lead of Chitra', 'Lead of Dev'], 'the seeded Employee role keeps today’s rule: the whole company');
  assert.deepEqual(await seen(B), [], 'never another company');

  await setLevel('Employee', 'lead', 'read', 'own');
  assert.deepEqual(await seen(A), ['Lead of Anil']);
  assert.deepEqual(await seen(M), ['Lead of Anil', 'Lead of Chitra', 'Lead of Dev'], 'managers keep everything');

  await setLevel('Employee', 'lead', 'read', 'department');
  assert.deepEqual(await seen(A), ['Lead of Anil', 'Lead of Chitra'], 'Sales sees Sales, not the Support sub-department');
  assert.deepEqual(await seen(D), ['Lead of Dev']);

  await setLevel('Employee', 'lead', 'read', 'subdepartments');
  assert.deepEqual(await seen(A), ['Lead of Anil', 'Lead of Chitra', 'Lead of Dev'], '…until sub-departments are included');
  assert.deepEqual(await seen(D), ['Lead of Dev'], 'a sub-department does not see upwards');
  assert.deepEqual(await seen(B), [], 'and still never another company');

  // A role given to a department reaches its sub-departments too.
  const role = await one(X, `insert into crm_roles (name) values ('Sales team') returning id`);
  await q(X, `insert into crm_role_permissions (role_id, entity, action, level) values ($1, 'lead', 'delete', 'department')`, [role.id]);
  await q(X, `insert into crm_role_assignments (role_id, principal_type, principal_id) values ($1, 'department', $2)`, [role.id, ids.Sales]);
  assert.equal((await q(A, `delete from crm_leads where id = $1 returning id`, [lc.id])).length, 1, 'Sales may now delete Sales leads');
  const ld = await one(D, `insert into crm_leads (name) values ('Temp of Dev') returning id`);
  assert.equal((await q(D, `delete from crm_leads where id = $1 returning id`, [ld.id])).length, 1, 'Support inherits the Sales role');
  assert.equal((await q(B, `delete from crm_leads where id = $1 returning id`, [la.id])).length, 0);

  await setLevel('Employee', 'lead', 'read', 'all');
  const levels = json((await one(A, `select public.ws_crm_levels('lead', 'delete') l`)).l);
  assert.deepEqual(levels, { '*': 'department' }, 'the browser can ask what it may do');
});

test('a pipeline can be closed to a role, and stage moves can be limited', { skip }, async () => {
  const p2 = await one(M, `insert into crm_pipelines (name, company) values ('Wholesale', $1) returning id`, [NOVA]);
  const s1 = await one(M, `insert into crm_pipeline_stages (pipeline_id, name, position) values ($1, 'Open', 1) returning id`, [p2.id]);
  const def = await one(A, `select p.id, (select id from crm_pipeline_stages where pipeline_id = p.id order by position limit 1) stage
                              from crm_pipelines p where p.is_default limit 1`);
  const dA = await one(A, `insert into crm_deals (title, owner_id, pipeline_id, stage_id) values ('Default deal', $1, $2, $3) returning id`, [A, def.id, def.stage]);
  const dW = await one(M, `insert into crm_deals (title, owner_id, pipeline_id, stage_id) values ('Wholesale deal', $1, $2, $3) returning id`, [M, p2.id, s1.id]);
  ids.deal = dA.id;

  await setLevel('Employee', 'deal', 'read', 'none', p2.id);
  await setLevel('Employee', 'deal', 'add', 'none', p2.id);
  const titles = async uid => (await q(uid, `select title from crm_deals order by title`)).map(r => r.title);
  assert.deepEqual(await titles(A), ['Default deal']);
  assert.deepEqual(await titles(M), ['Default deal', 'Wholesale deal']);
  await assert.rejects(q(A, `insert into crm_deals (title, pipeline_id, stage_id) values ('Sneak', $1, $2)`, [p2.id, s1.id]), RLS);
  assert.equal((await q(A, `select id from crm_deals where id = $1`, [dW.id])).length, 0);

  const stages = (await svc(`select id, name from crm_pipeline_stages where pipeline_id = $1 order by position`, [def.id]));
  const won = stages.find(s => s.name === 'Won');
  const emp = (await svc(`select id from crm_roles where name = 'Employee'`))[0].id;
  await q(X, `update crm_role_permissions set extra = jsonb_build_object('stages', jsonb_build_array($2::text, $3::text))
               where role_id = $1 and entity = 'deal' and action = 'move_stage' and pipeline_id is null`, [emp, stages[0].id, stages[1].id]);
  await assert.rejects(q(A, `update crm_deals set stage_id = $1 where id = $2`, [won.id, dA.id]), /may not move deals into this stage/);
  assert.equal((await q(A, `update crm_deals set stage_id = $1 where id = $2 returning id`, [stages[1].id, dA.id])).length, 1, 'allowed stages still work');
  assert.equal((await q(M, `update crm_deals set stage_id = $1 where id = $2 returning id`, [won.id, dA.id])).length, 1, 'the Manager role is not limited');
  await q(X, `update crm_role_permissions set extra = '{}' where role_id = $1 and action = 'move_stage'`, [emp]);
});

test('converting a lead creates the customer company once and links contact and deal to it', { skip }, async () => {
  const l1 = await one(A, `insert into crm_leads (name, organization, email) values ('Priya Nair', 'Globex Retail', 'priya@globex.test') returning id`);
  const r1 = json((await one(A, `select public.crm_convert_lead($1::uuid) r`, [l1.id])).r);
  assert.ok(r1.company_id, 'a company is created from the organisation');
  const l2 = await one(A, `insert into crm_leads (name, organization, email) values ('Omar Ali', 'globex retail', 'omar@globex.test') returning id`);
  const r2 = json((await one(A, `select public.crm_convert_lead(p_lead_id => $1::uuid, p_create_deal => false) r`, [l2.id])).r);
  assert.equal(r2.company_id, r1.company_id, 'the same organisation is linked, not duplicated');
  assert.equal(r2.deal_id, null);
  const co = await one(A, `select title, number, owner_id from crm_companies where id = $1`, [r1.company_id]);
  assert.equal(co.title, 'Globex Retail');
  assert.ok(Number(co.number) > 0);
  assert.equal((await one(A, `select company_id from crm_contacts where id = $1`, [r1.contact_id])).company_id, r1.company_id);
  assert.equal((await one(A, `select company_id from crm_deals where id = $1`, [r1.deal_id])).company_id, r1.company_id);
  assert.equal((await q(B, `select id from crm_companies where id = $1`, [r1.company_id])).length, 0);
  const acts = (await q(A, `select action from crm_activities where entity_id = $1`, [r1.company_id])).map(r => r.action);
  assert.ok(acts.includes('company.created'));
});

test('custom fields: set up under the CRM settings permission and stored on the record', { skip }, async () => {
  const f = await one(M, `insert into crm_custom_fields (company, entity, code, label, field_type, options)
                          values ($1, 'deal', 'region', 'Region', 'list', '[{"value":"n","label":"North"}]') returning id`, [NOVA]);
  assert.ok(f.id);
  await assert.rejects(q(A, `insert into crm_custom_fields (company, entity, code, label) values ($1, 'deal', 'mine', 'Mine')`, [NOVA]), RLS);
  await assert.rejects(q(M, `insert into crm_custom_fields (company, entity, code, label) values ($1, 'deal', 'Bad Code!', 'Bad')`, [NOVA]), /crm_custom_fields_code_ck/);
  await assert.rejects(q(M, `insert into crm_custom_fields (company, entity, code, label) values (null, 'deal', 'global', 'Global')`), RLS, 'shared fields are for admins');
  assert.equal((await q(A, `select id from crm_custom_fields`)).length, 1);
  assert.equal((await q(B, `select id from crm_custom_fields`)).length, 0);
  const d = await one(A, `update crm_deals set custom = custom || '{"region":"n"}' where id = $1 returning custom`, [ids.deal]);
  assert.deepEqual(json(d.custom), { region: 'n' });
  await assert.rejects(q(A, `update crm_deals set custom = '[]' where id = $1`, [ids.deal]), /custom_ck/);
});

test('deal products compute their lines and can drive the deal amount', { skip }, async () => {
  await assert.rejects(q(A, `insert into crm_products (name, price) values ('Bat', 100)`), RLS, 'the catalogue is a manager setting');
  const prod = await one(M, `insert into crm_products (name, price, tax_rate) values ('Cricket bat', 100, 18) returning id, company`);
  assert.equal(prod.company, NOVA);
  await q(A, `update crm_deals set amount_from_products = true where id = $1`, [ids.deal]);
  await q(A, `insert into crm_deal_products (deal_id, product_id, name, price, quantity, discount_pct, tax_rate) values ($1, $2, 'Cricket bat', 100, 2, 10, 18)`, [ids.deal, prod.id]);
  const line = await one(A, `select line_total::text t from crm_deal_products where deal_id = $1`, [ids.deal]);
  assert.equal(line.t, '212.40', '2 × 100, less 10 %, plus 18 % tax');
  assert.equal((await one(A, `select value::text v from crm_deals where id = $1`, [ids.deal])).v, '212.40');
  await assert.rejects(q(C, `insert into crm_deal_products (deal_id, name, price) values ($1, 'x', 1)`, [ids.deal]), RLS, 'only people who may edit the deal');
});

test('automation: moving a lead into a stage creates the follow-up task and notifies', { skip }, async () => {
  await assert.rejects(q(A, `insert into crm_automation_rules (entity, stage_key, action) values ('lead', 'contacted', 'create_task')`), RLS);
  await q(M, `insert into crm_automation_rules (entity, stage_key, action, params) values
                ('lead', 'contacted', 'create_task', '{"title":"Call {title}","due_days":1}'),
                ('lead', 'contacted', 'notify', jsonb_build_object('user', $1::text, 'title', '{title} was contacted'))`, [M]);
  const lead = await one(A, `insert into crm_leads (name, owner_id) values ('Kiran Shop', $1) returning id`, [A]);
  await q(A, `update crm_leads set status = 'contacted' where id = $1`, [lead.id]);
  const t = await one(A, `select title, assignee_id, lead_id, due_date - (now() at time zone 'Asia/Kolkata')::date days from tasks where lead_id = $1`, [lead.id]);
  assert.deepEqual([t.title, t.assignee_id, t.days], ['Call Kiran Shop', A, 1]);
  assert.ok((await q(M, `select id from notifications where user_id = $1 and kind = 'lead.automation'`, [M])).length);
  assert.equal((await q(A, `select id from crm_activities where lead_id = $1 and action = 'automation.ran'`, [lead.id])).length, 2);
  await assert.rejects(q(A, `select public.crm_run_automation('lead', '{}'::jsonb, 'new')`), /permission denied/);
});

test('projects: secret ones stay with their members, public ones can be joined, private ones by request', { skip }, async () => {
  const sec = await one(M, `insert into projects (name, privacy) values ('Acquisition', 'secret') returning id`);
  await q(M, `insert into project_members (project_id, user_id) values ($1, $2)`, [sec.id, A]);
  const task = await one(M, `insert into tasks (title, project_id) values ('Due diligence', $1) returning id`, [sec.id]);
  assert.equal((await q(A, `select id from projects where id = $1`, [sec.id])).length, 1);
  assert.equal((await q(C, `select id from projects where id = $1`, [sec.id])).length, 0, 'a secret project is invisible');
  assert.equal((await q(C, `select id from tasks where id = $1`, [task.id])).length, 0, 'and so are its tasks');
  assert.equal((await q(X, `select id from projects where id = $1`, [sec.id])).length, 1);

  const pub = await one(M, `insert into projects (name) values ('Open house') returning id, number`);
  assert.ok(Number(pub.number) > 0);
  assert.equal((await q(C, `insert into project_members (project_id, user_id) values ($1, $2) returning role`, [pub.id, C]))[0].role, 'member');
  const pri = await one(M, `insert into projects (name, privacy) values ('Board prep', 'private') returning id`);
  await assert.rejects(q(C, `insert into project_members (project_id, user_id, role) values ($1, $2, 'owner')`, [pub.id, D]), RLS);
  await assert.rejects(q(C, `insert into project_members (project_id, user_id) values ($1, $2)`, [pri.id, C]), RLS, 'private: ask first');
  const req = await one(C, `insert into project_join_requests (project_id, user_id, message) values ($1, $2, 'May I?') returning id`, [pri.id, C]);
  await assert.rejects(q(C, `update project_join_requests set status = 'approved' where id = $1`, [req.id]), RLS, 'nobody approves themselves');
  assert.ok((await q(M, `select id from notifications where user_id = $1 and kind = 'project.join_request'`, [M])).length);
  assert.equal((await q(M, `update project_join_requests set status = 'approved' where id = $1 returning decided_by`, [req.id]))[0].decided_by, M);
  assert.equal((await q(C, `select user_id from project_members where project_id = $1 and user_id = $2`, [pri.id, C])).length, 1);
  assert.ok((await q(C, `select id from notifications where user_id = $1 and kind = 'project.join_approved'`, [C])).length);
});

test('the planner and read markers are private to each person', { skip }, async () => {
  const t = await one(A, `insert into tasks (title, assignee_id) values ('Plan me', $1) returning id`, [A]);
  await q(A, `insert into task_planner (user_id, task_id, stage) values ($1, $2, 'today')`, [A, t.id]);
  await q(A, `insert into task_views (user_id, task_id) values ($1, $2)`, [A, t.id]);
  assert.equal((await q(C, `select * from task_planner`)).length, 0);
  assert.equal((await q(C, `select * from task_views`)).length, 0);
  await assert.rejects(q(C, `insert into task_planner (user_id, task_id) values ($1, $2)`, [A, t.id]), RLS);
  const tpl = await one(A, `insert into task_templates (title, deadline_days) values ('Weekly report', 7) returning company`);
  assert.equal(tpl.company, NOVA);
  assert.equal((await q(B, `select id from task_templates`)).length, 0);
});

test('the feed: audiences, announcements, comments and reactions', { skip }, async () => {
  const post = await one(A, `insert into feed_posts (body) values ('Hello team') returning id, company, author_id`);
  assert.deepEqual([post.company, post.author_id], [NOVA, A]);
  assert.equal((await q(C, `select id from feed_posts where id = $1`, [post.id])).length, 1);
  assert.equal((await q(B, `select id from feed_posts where id = $1`, [post.id])).length, 0);
  await assert.rejects(q(A, `insert into feed_posts (body, kind) values ('Big news', 'announcement')`), RLS, 'announcements are for managers');
  await assert.rejects(q(A, `insert into feed_posts (body, audience) values ('Everyone!', 'all')`), RLS);
  await q(M, `insert into feed_posts (title, body, kind) values ('Holiday', 'Office closed Friday', 'announcement')`);
  assert.ok((await q(C, `select id from notifications where user_id = $1 and kind = 'feed.announcement'`, [C])).length);
  assert.equal((await svc(`select count(*)::int n from notifications where user_id = $1 and kind = 'feed.announcement'`, [B]))[0].n, 0);

  const dep = await one(A, `insert into feed_posts (body, audience, audience_ids) values ('Sales only', 'department', array[$1::uuid]) returning id`, [ids.Sales]);
  assert.equal((await q(C, `select id from feed_posts where id = $1`, [dep.id])).length, 1);
  assert.equal((await q(D, `select id from feed_posts where id = $1`, [dep.id])).length, 1, 'sub-departments are included');
  assert.equal((await q(M, `select id from feed_posts where id = $1`, [dep.id])).length, 0);

  await q(C, `insert into feed_comments (post_id, body) values ($1, 'Hi Anil')`, [post.id]).catch(async e => {
    // author_id is filled from the caller when the client leaves it out
    throw e;
  });
  assert.ok((await q(A, `select id from notifications where user_id = $1 and kind = 'feed.comment'`, [A])).length);
  await q(C, `insert into feed_reactions (post_id, user_id) values ($1, $2)`, [post.id, C]);
  await assert.rejects(q(B, `insert into feed_reactions (post_id, user_id) values ($1, $2)`, [post.id, B]), RLS);
});

test('whiteboards and drive documents: private, shared, and published links', { skip }, async () => {
  const wb = await one(A, `insert into whiteboards (name, visibility) values ('Plan', 'private') returning id`);
  assert.equal((await q(C, `select id from whiteboards where id = $1`, [wb.id])).length, 0);
  await q(A, `insert into whiteboard_shares (whiteboard_id, user_id, can_edit) values ($1, $2, false)`, [wb.id, C]);
  assert.equal((await q(C, `select id from whiteboards where id = $1`, [wb.id])).length, 1);
  assert.equal((await q(C, `update whiteboards set name = 'Mine' where id = $1 returning id`, [wb.id])).length, 0, 'view-only share');
  const team = await one(A, `insert into whiteboards (name) values ('Team board') returning id`);
  assert.equal((await q(C, `update whiteboards set data = '{"elements":[{"t":"rect"}]}' where id = $1 returning id`, [team.id])).length, 1, 'company boards are shared work');

  const doc = await one(A, `insert into documents (name, doc_kind, visibility, content, mime_type, size_bytes)
                            values ('Notes', 'document', 'private', '{"html":"<p>Hi</p>"}', 'application/json', 0) returning id`);
  assert.equal((await q(C, `select id from documents where id = $1`, [doc.id])).length, 0, 'private to the author');
  await q(A, `insert into document_shares (document_id, user_id) values ($1, $2)`, [doc.id, C]);
  assert.equal((await q(C, `select id from documents where id = $1`, [doc.id])).length, 1);
  assert.equal((await q(C, `update documents set name = 'x' where id = $1 returning id`, [doc.id])).length, 0, 'read-only share');
  assert.equal((await q(M, `delete from documents where id = $1 returning id`, [doc.id])).length, 0, 'a manager cannot delete a private file they cannot see');
  await assert.rejects(q(A, `insert into documents (name, doc_kind, mime_type, size_bytes) values ('Lost', 'file', 'application/pdf', 1)`), /documents_drive_ck/);

  const token = 'a'.repeat(32);
  await q(A, `update documents set published_token = $1, published_at = now() where id = $2`, [token, doc.id]);
  const pub = json((await anon(`select public.ws_published_document($1) d`, [token]))[0].d);
  assert.equal(pub.name, 'Notes');
  assert.deepEqual(json(pub.content), { html: '<p>Hi</p>' });
  assert.equal((await anon(`select public.ws_published_document('short') d`))[0].d, null, 'guessable tokens are refused');
  await q(A, `update documents set published_token = null where id = $1`, [doc.id]);
  assert.equal((await anon(`select public.ws_published_document($1) d`, [token]))[0].d, null, 'unpublishing ends the link');
});

test('invoices follow the matrix: employees read only their own, a responsible person is stamped', { skip }, async () => {
  const inv = await one(M, `insert into invoices (bill_to_name, subject) values ('Globex', 'Kit order') returning id, responsible_id`);
  assert.equal(inv.responsible_id, M);
  await assert.rejects(q(A, `insert into invoices (bill_to_name) values ('Sneak')`), RLS);
  assert.equal((await q(A, `select id from invoices where id = $1`, [inv.id])).length, 0);
  await q(M, `update invoices set responsible_id = $1 where id = $2`, [A, inv.id]);
  assert.equal((await q(A, `select id from invoices where id = $1`, [inv.id])).length, 1, 'the responsible person sees it');
  assert.equal((await q(A, `update invoices set subject = 'x' where id = $1 returning id`, [inv.id])).length, 0, 'but does not edit it');
  const dup = await one(M, `select public.invoice_duplicate($1) id`, [inv.id]);
  assert.ok(dup.id);
});

test('interface settings belong to their owner', { skip }, async () => {
  await q(A, `insert into user_ui_settings (user_id, key, value) values ($1, 'menu', '{"order":["tasks"]}')`, [A]);
  assert.equal((await q(C, `select * from user_ui_settings`)).length, 0);
  await assert.rejects(q(A, `insert into workspace_settings (company, key) values ($1, 'theme')`, [NOVA]), RLS);
  await q(M, `insert into workspace_settings (company, key, value) values ($1, 'theme', '{"wallpaper":"dusk"}')`, [NOVA]);
  assert.equal((await q(A, `select key from workspace_settings`)).length, 1);
  assert.equal((await q(B, `select key from workspace_settings`)).length, 0);
});
