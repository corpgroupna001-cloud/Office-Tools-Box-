-- ============================================================
-- Which Bitrix24 workgroup each company posts into
--
-- Kept as data, not as a constant in the code, so a fourth group - or a
-- company moving to a different one - is an edit in Admin rather than a
-- deploy. A null or blank dialog_id means "do not post for this company",
-- which is also the state everything starts in: nothing goes to Bitrix
-- until somebody deliberately maps a group.
--
-- dialog_id holds Bitrix's DIALOG_ID, and the prefix matters:
--     sgNN    a workgroup / project chat   <- what we want
--     chatNN  an ordinary chat
--     NN      a PERSON
-- A bare number would direct-message user NN instead of posting to group
-- NN, so lib/bitrix.js normalises anything unprefixed to sg.
--
-- Run ONCE in Supabase -> SQL Editor. Idempotent.
-- ============================================================

create table if not exists public.bitrix_targets (
  company    text primary key,
  dialog_id  text,
  label      text,
  enabled    boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Seed every company with NO group, so nothing can post by accident before
-- the mapping is set. on conflict do nothing keeps a re-run harmless.
insert into public.bitrix_targets (company, label) values
  ('Nova Sportsmart Private Limited',  'SportsMart Working Hours'),
  ('Protathlitis Sportsmart LLP',      'SportsMart Working Hours'),
  ('CORPGROUP',                        'SportsMart Working Hours'),
  ('Jobways Point LLP',                'Jobways Working Hours'),
  ('Genie Lamp Private Limited',       'Genie Lamp Working Hours'),
  ('Navyug Raise A Player Foundation', null),
  ('Raise a Player',                   null)
on conflict (company) do nothing;

-- ============================================================
-- No policies, deliberately - same reasoning as public.salaries.
--
-- With RLS on and nothing granting select, an employee token reads zero
-- rows. Only the service_role key reaches this, and that key lives solely
-- in the Vercel environment behind the admin password. Nothing in a browser
-- needs the mapping: the posting happens server-side, because the webhook
-- URL is itself the credential and must never reach a page.
-- ============================================================
alter table public.bitrix_targets enable row level security;
