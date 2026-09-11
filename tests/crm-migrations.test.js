// Static checks on the CRM migration files: the things that must be true of
// an upgrade migration regardless of what the database looks like.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FILES = [
  'supabase-crm-foundation-migration.sql',
  'supabase-work-migration.sql',
  'supabase-invoices-migration.sql',
  'supabase-messenger-migration.sql',
  'supabase-crm-reminders-migration.sql',
];
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const stripComments = sql => sql.replace(/--[^\n]*/g, '');

test('every CRM migration file exists and is non-trivial', () => {
  for (const f of FILES) {
    const sql = read(f);
    assert.ok(sql.length > 2000, `${f} is suspiciously short`);
  }
});

test('migrations never drop the database, drop a schema, or truncate anything', () => {
  for (const f of FILES) {
    const sql = stripComments(read(f)).toLowerCase();
    assert.doesNotMatch(sql, /drop\s+database/, f);
    assert.doesNotMatch(sql, /drop\s+schema/, f);
    assert.doesNotMatch(sql, /\btruncate\b/, f);
    assert.doesNotMatch(sql, /drop\s+table/, f);
    // The one delete allowed: the reminders job trimming its own bookkeeping table.
    assert.doesNotMatch(sql.replace(/delete\s+from\s+public\.crm_reminder_log\b/g, ''), /delete\s+from\s+public\./, f);
  }
});

test('every table a migration creates has row level security enabled', () => {
  for (const f of FILES) {
    const sql = stripComments(read(f)).toLowerCase();
    const created = [...sql.matchAll(/create\s+table\s+if\s+not\s+exists\s+public\.([a-z_]+)/g)].map(m => m[1]);
    assert.ok(created.length, `${f} creates no tables?`);
    for (const t of created) {
      assert.match(sql, new RegExp(`alter\\s+table\\s+public\\.${t}\\s+enable\\s+row\\s+level\\s+security`), `${f}: ${t} has no RLS`);
    }
  }
});

test('no sensitive business table gets a blanket USING (true) policy', () => {
  // Reference/lookup tables are the only ones readable by everyone.
  const allowed = new Set(['crm_lead_statuses', 'task_statuses']);
  for (const f of FILES) {
    const sql = stripComments(read(f));
    const blanket = [...sql.matchAll(/create\s+policy\s+\w+\s+on\s+public\.([a-z_]+)[^;]*?using\s*\(\s*true\s*\)/gis)].map(m => m[1]);
    for (const t of blanket) assert.ok(allowed.has(t), `${f}: ${t} has a USING (true) policy`);
  }
});

test('DDL is idempotent: tables, indexes and policies are guarded for re-runs', () => {
  for (const f of FILES) {
    const sql = stripComments(read(f));
    const bareTables = sql.match(/create\s+table\s+public\./gi) || [];
    assert.equal(bareTables.length, 0, `${f}: create table without if not exists`);
    const bareIndexes = sql.match(/create\s+(unique\s+)?index\s+(?!if\s+not\s+exists)\w/gi) || [];
    assert.equal(bareIndexes.length, 0, `${f}: create index without if not exists`);
    const policies = [...sql.matchAll(/create\s+policy\s+("?[\w ]+"?)\s+on\s+public\.([a-z_]+)/gi)];
    for (const [, name, table] of policies) {
      assert.match(sql, new RegExp(`drop\\s+policy\\s+if\\s+exists\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+on\\s+public\\.${table}`, 'i'),
        `${f}: policy ${name} on ${table} is not dropped before it is created`);
    }
    const triggers = [...sql.matchAll(/create\s+trigger\s+(\w+)\s+/gi)].map(m => m[1]);
    for (const t of triggers) {
      assert.match(sql, new RegExp(`drop\\s+trigger\\s+if\\s+exists\\s+${t}\\s+on`, 'i'), `${f}: trigger ${t} is not dropped first`);
    }
  }
});

test('the profile role guard cannot be bypassed by a signed-in employee', () => {
  const sql = read('supabase-crm-foundation-migration.sql');
  assert.match(sql, /app_role can only be changed by an administrator/);
  assert.match(sql, /before update of app_role on public\.profiles/);
  assert.match(sql, /check \(app_role in \('employee', 'manager', 'admin'\)\)/);
});

test('invoice money columns are owned by the database, never the client', () => {
  const sql = read('supabase-invoices-migration.sql');
  assert.match(sql, /new\.subtotal := old\.subtotal/);
  assert.match(sql, /new\.total := old\.total/);
  assert.match(sql, /round\(new\.quantity \* new\.unit_price, 2\)/);
  assert.match(sql, /Line items can only be changed while the invoice is a draft/);
  assert.match(sql, /exceeds the outstanding balance/);
});

test('the messenger migration keeps direct messages exactly as they were', () => {
  const sql = read('supabase-messenger-migration.sql');
  assert.match(sql, /recipient_id drop not null/, 'groups need a nullable recipient');
  assert.match(sql, /\(recipient_id is not null and conversation_id is null\)/, 'a DM stays a DM');
  assert.doesNotMatch(stripComments(sql), /drop\s+policy\s+if\s+exists\s+"?msg_select_own/, 'existing DM read policy must survive');
  assert.match(sql, /create policy "msg_insert_own" on public\.messages\s+for insert\s+with check \(auth\.uid\(\) = sender_id and conversation_id is null\)/,
    'the DM insert rule is kept, limited to direct messages so nobody posts into a group they are not in');
});

test('the documents bucket is private and reads are gated on the metadata row', () => {
  const sql = read('supabase-work-migration.sql');
  assert.match(sql, /values \('documents', 'documents', false/);
  assert.match(sql, /ws_document_visible\(name\)/);
  assert.match(sql, /\(storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text/);
});
