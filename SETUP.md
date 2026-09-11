# WorkSuite — Auth & Admin Setup Guide

Follow these 4 steps in order. Total time: ~10 minutes.

---

## Step 1 — Create a Supabase project (free tier)

1. Go to https://supabase.com/dashboard → **New project**
2. Fill in:
   - **Name:** `worksuite` (any name is fine)
   - **Database password:** generate + save it somewhere safe
   - **Region:** pick the one closest to your users (e.g. Mumbai for India)
3. Wait ~2 minutes for the project to spin up.

---

## Step 2 — Run the SQL schema

1. In your Supabase project, open **SQL Editor → New query**
2. Open the file `supabase-schema.sql` from this repo
3. Copy all of its contents into the SQL editor and click **Run**
4. You should see "Success. No rows returned."

This creates:
- `profiles` table (auto-populated on signup)
- `test_results` table (stores every typing test result)
- Row Level Security so employees only see their own data
- A trigger that auto-creates a profile row when someone signs up

---

## Step 3 — Grab your API keys

In Supabase: **Settings → API**. Copy these 3 values:

| Value in Supabase | What to call it |
|---|---|
| Project URL | `SUPABASE_URL` |
| `anon` `public` key | `SUPABASE_ANON_KEY` |
| `service_role` `secret` key | `SUPABASE_SERVICE_ROLE_KEY` |

⚠️ The **service_role** key is a full-access key — never put it in the client. It only lives in the server env vars.

---

## Step 4 — Add environment variables in Vercel

Go to **Vercel → your `work-suite` project → Settings → Environment Variables**. Add these:

| Name | Value | Environments |
|---|---|---|
| `SUPABASE_URL` | (Project URL from Step 3) | Production, Preview, Development |
| `SUPABASE_ANON_KEY` | (anon public key) | Production, Preview, Development |
| `SUPABASE_SERVICE_ROLE_KEY` | (service_role secret key) | Production, Preview, Development |
| `ADMIN_PASSWORD` | (pick a strong password for the admin dashboard) | Production, Preview, Development |
| `GROQ_API_KEY` | (already set) | — |

After saving, **redeploy** the project (Deployments → latest → Redeploy). Env changes only take effect on new deploys.

---

## Step 5 — (Optional) Turn off email confirmation for faster onboarding

By default Supabase requires email confirmation. If you want employees to sign up and log in immediately without confirming:

1. Supabase → **Authentication → Providers → Email**
2. Uncheck **Confirm email**
3. Click **Save**

---

## URLs after setup

| URL | What it does |
|---|---|
| `https://work-suite-mauve.vercel.app/` | Landing page (hub) |
| `https://work-suite-mauve.vercel.app/typingtest/` | ZenType — login required |
| `https://work-suite-mauve.vercel.app/signature/` | Signature Gen |
| `https://work-suite-mauve.vercel.app/attendance/` | My Attendance — login required |
| `https://work-suite-mauve.vercel.app/api/attendance-webhook` | Biometric device push endpoint (Bearer key) |
| `https://work-suite-mauve.vercel.app/wsm-admin` | Admin dashboard — password required |

---

## Testing

1. Visit `/typingtest/` → sign up with your email + password
2. Complete a test → you should see the "Download Result" button and a saved record in Supabase (`test_results` table)
3. Visit `/wsm-admin` → enter your `ADMIN_PASSWORD` → you should see your test result

---

## Step 6 — Biometric Attendance (in/out email notifications)

Every time someone touches the biometric reader, the Realtime / OnlineRealSoft
cloud POSTs the punch to WorkSuite, which stores it and emails that employee
straight away.

### 6.1 Run the migration

Supabase → **SQL Editor → New query** → paste all of
`supabase-attendance-migration.sql` → **Run**.

This adds `profiles.employee_code` and the `attendance_logs` table.

### 6.2 Add one environment variable

Vercel → Project Settings → **Environment Variables**:

| Name | Value |
|---|---|
| `BIOMETRIC_API_KEY` | a long random secret — this is what the device sends us |

Optional:

| Name | Default | What it does |
|---|---|---|
| `ATTENDANCE_EMAIL_MAX_AGE_HOURS` | `12` | Punches older than this are stored but **not** emailed. Stops the vendor's "Manual Data Export" replay from spamming everyone with last month's punches. |

Redeploy after saving.

### 6.3 Configure the device cloud

Log in to `https://onlinerealsoft.com` → **ERP_Third_PartyApi.aspx**
("Parallel Data Export Setting"), and set:

| Setting | Value |
|---|---|
| API Type | Third Party Api |
| Request Method | **POST** |
| Authorization Auth Type | **Bearer Token** → paste `BIOMETRIC_API_KEY` |
| Content-Type | `application/json` |
| Data Sending Format | **Body** |
| API URL | `https://work-suite-mauve.vercel.app/api/attendance-webhook` |
| Active Parallel Third-party API Transfer | ✅ checked |

Parameter name mapping (tick the checkbox next to each one you fill in):

| Field on their page | Parameter name to type | Format |
|---|---|---|
| Emp.Code | `employee_code` | — |
| Employee Name | `employee_name` | — |
| In / Out | `IN` / `OUT` | — |
| Log Date Time | `log_datetime` | `yyyy-MM-dd HH:mm:ss` |
| Download Date Time | `downloaded_at` | `yyyy-MM-dd HH:mm:ss` |
| Device Serial No | `device_sn` | — |
| Device Name | `device_name` | — |

`Log Date` and `Log Time` can be left blank — `log_datetime` covers both.

### 6.3a IN/OUT is derived, not sent

The Realtime "Third Party Api" export sends **six fields and no direction**:

```json
{ "employee_code": "00000008", "employee_name": "Vinay Sirimilla",
  "log_datetime": "2026-09-01 19:05:02", "downloaded_at": "2026-09-02 13:16:53",
  "device_sn": "RSS202512133933", "device_name": "" }
```

The In / Out boxes on their settings page produced no key in the payload, so
the webhook **derives** the direction from the punch's position in that
employee's IST day — 1st punch = IN, 2nd = OUT, 3rd = IN, and so on. Rows
derived this way carry `direction_derived = true`.

Consequences worth knowing:

- If someone forgets to punch once, every later punch that day flips. This is
  the normal trade-off for devices that log punches without in/out mode, and
  it is what the vendor's own reports do.
- Because direction is computed, it is deliberately **not** part of the
  dedupe key — that is `(employee_code, log_datetime, device_sn)`. Were
  direction included, a recomputed parity would insert a second row for the
  same punch and email the employee twice.
- An explicit direction from the device always wins. If Realtime support
  enables in/out mode (ask about the **In / Out** boxes), no code change is
  needed — the derivation only runs when no direction arrives.

Run `supabase-attendance-direction-migration.sql` to add
`direction_derived`, switch the dedupe index, and backfill any punches
already stored as `UNKNOWN`.

### 6.4 Employee codes map themselves

You do **not** need to type in 24 employee codes. The first time a code
arrives, the webhook matches the **employee name** the device sends against
`profiles.full_name` and remembers the code on that profile. It only ever
does this when exactly one person matches — anything ambiguous is parked in
**Admin → 🕐 Attendance → Unmapped device codes**, where you bind it with one
click. Binding a code also re-points that code's past punches.

### 6.5 Checking it works

- `GET /api/attendance-webhook` with the Bearer key returns `{ ok: true }` —
  handy for confirming the URL and key before you switch the transfer on.
- Admin → **🕐 Attendance** shows the daily report (first IN, last OUT, hours,
  absentees), a live punch feed, mail status per punch, CSV export, and a
  **Resend failed** button. (Its actions live inside `/api/admin` under the
  `att_` prefix — see the note below.)
- Employees see their own punches at `/attendance/`.

Email and Bitrix delivery run in independent queues. A slow email send or
email-status update must not prevent the same punch from reaching Bitrix.
Check **Admin → Bitrix → delivery log** for Bitrix failures separately from
the attendance email status. A `deadline` entry means the punch was stored,
but Bitrix delivery did not start before the request's time budget expired.
The webhook reports these as `bitrix_deferred`.

An email marked `sent` does not confirm Bitrix delivery. The attendance
**Resend failed** action retries email only; replaying a biometric export
does not resend notifications for already-stored punches. This fix does
not automatically recover older missing Bitrix messages.

Run `npm test` for the mocked biometric-delivery regression tests; they do
not contact Supabase, SMTP, or Bitrix.

### Notes

- The endpoint always answers `200` once a punch is stored — the vendor logs
  any non-2xx as an error, and a mail failure is ours to retry, not theirs.
- Replays are ignored: `(employee_code, log_datetime, direction, device_sn)`
  is unique, so re-exporting a date range inserts nothing and emails nothing.
- Naive timestamps from the device are read as **IST**.

## Step 7 — Employee shift timings

Named shift templates assigned to employees, used to flag late arrivals and
early departures against the biometric data.

### 7.1 Run the migration

Supabase → SQL Editor → paste `supabase-shifts-migration.sql` → Run.
Creates `shifts`, adds `profiles.shift_id`, and seeds a **General**
09:30–18:30 shift (Mon–Sat, 10-minute grace) marked as the default.

### 7.2 Set them up

Admin → **⏰ Shifts**:

- **Shift templates** — create/edit/delete. Each has a start, an end, a late
  grace, an early-out grace, and its working days. One shift can be marked
  *default*, which applies to anyone not explicitly assigned.
- **Who works which shift** — a dropdown per employee, saved on change, plus
  "Apply to all shown" for bulk assignment (respects the search box, so you
  can filter to one company and assign in a single click).

Deleting a shift leaves its people unassigned (`ON DELETE SET NULL`); their
attendance history is untouched.

### 7.3 What it changes

| Where | Effect |
|---|---|
| Admin → 🕐 Attendance | Shift column, `▲ 22m late` under First IN, `▼ 50m early` under Last OUT, plus Late / Early-out / Week-off tiles. All of it in the CSV export. |
| Punch email | Subject becomes `Checked In at 9:52 AM (22m late)`, with a coloured pill in the body. On-time punches read normally. |
| `/attendance` | Shows the employee's shift window and tags today's check-in *On time* or *22m late*. |

Non-working days show as **Week-off** rather than Absent, so Sundays no
longer read as 24 people failing to turn up.

### Overnight shifts

`end_time <= start_time` means the shift crosses midnight (22:00 → 07:00).
Comparisons rotate the clock difference onto ±12 hours, so a 01:00 punch on a
22:00 shift reads as **3 hours late**, not 21 hours early. No extra flag to set.

### When a late/early note is *not* shown on an email

The email only annotates a boundary it can stand behind:

- **Lateness** only on the day's **first** punch — a 2:10pm return from lunch
  is not "4h 40m late for a 09:30 shift".
- **Early-out** only from the shift's **midpoint** onwards, so stepping out at
  1pm isn't reported as leaving early.

The admin report has no such restriction: it works from the day's real first
IN and last OUT.

## Step 8 — Selfie attendance for WFH employees

WFH staff clock in and out — and start/end breaks — with a selfie plus a
**mandatory** GPS fix. These land in the same `attendance_logs` table as the
biometric punches, so one daily report, one set of emails and one set of
shift rules cover office and home alike.

### 8.1 Run the migration

Supabase → SQL Editor → `supabase-selfie-migration.sql`. Adds the selfie
columns to `attendance_logs`, creates the private `selfies` bucket with
per-user folder policies, and makes `employee_code` nullable (a WFH employee
may have no biometric reader code at all).

### 8.2 Mark who is WFH

Admin → **👥 Employees** → the 🏠 toggle. The selfie panel only appears for
people flagged `is_wfh`, and the server rejects a punch from anyone else.

### 8.3 Daily reminders

Both Vercel cron slots now fire **daily** rather than Friday-only (Hobby
allows 2 crons at daily granularity), and `/api/wfh-remind` decides what each
run does:

| Run | Who gets a push |
|---|---|
| 9:00 AM IST | WFH staff with no `LOGIN` recorded today |
| 7:00 PM IST | WFH staff who logged in but never logged out, or who never logged in at all |

The Friday WFH-video and typing reminders keep their own Friday guard, so
that behaviour is unchanged.

`/attendance` also shows an in-app prompt card: *"You haven't logged in
today"* with a Login button, *"Still logged in"* after 5 PM, or a green
*"Attendance complete"* once both are recorded. It stays hidden when there is
nothing outstanding — a card that always says "all good" is one people learn
to ignore.

### 8.4 How it works

Employee opens `/attendance` and sees four buttons — **Login**, **Start
break**, **End break**, **Logout**. Each one asks for location and camera
together; both must succeed or the punch cannot be made. The photo is
downscaled to ~640px JPEG in the browser (~60KB) before upload.

Event → direction mapping, which is what keeps first-IN / last-OUT correct:

| Button | Stored as | Direction |
|---|---|---|
| Login | `LOGIN` | IN |
| Start break | `BREAK_OUT` | OUT |
| End break | `BREAK_IN` | IN |
| Logout | `LOGOUT` | OUT |

### 8.5 Why this needed no new API function

We are on Vercel Hobby's 12-function limit, so the browser posts to the
existing `/api/attendance-webhook` with the employee's **own Supabase access
token** instead of the device key. The endpoint verifies that token against
Supabase and only then files the punch.

That is also the security model: identity comes from the verified token, not
the payload, and **the timestamp is taken from the server**, so a punch can
be neither forged as somebody else nor backdated. The client only supplies
the event, the photo path and the GPS fix.

Other guards, each covered by a test:

- No location, a null/blank location, or coordinates out of range → refused.
  (`Number(null)` is `0`, so a blank latitude would otherwise be silently
  accepted as Null Island — checked explicitly.)
- A `selfie_path` outside the user's own folder → refused, in the storage
  policy *and* again in the handler.
- Not flagged WFH → refused.
- The same event twice inside 60 seconds → refused as a double-tap, with a
  partial unique index as the backstop.
- Employees have **no** update or delete policy on the bucket: once a selfie
  punch is recorded, the person who made it cannot alter or remove it.

### 8.6 Admin review

Admin → **📸 Selfies**: photo, name, event, time, and the GPS fix as a
Google Maps link, filterable by date and status, with Approve / Flag. Photos
are served as 1-hour signed URLs — the bucket is private.

### 8.7 Capture quality gates

Capture stays **disabled** until the frame passes three checks, shown live as
steps in the sheet:

| Check | Rule |
|---|---|
| Location | A GPS fix is mandatory — no fix, no punch. |
| Lighting | Mean luma must be 45–238 of 255. A black frame or one pointed at a lamp is refused, with the measured value shown. |
| Face | A face must be visible in the preview. |

Face detection uses Chromium's built-in `FaceDetector` where it exists (free,
instant) and otherwise loads BlazeFace from a CDN once.

**If neither is available it deliberately fails OPEN** and records
`face_method: 'unavailable'` on the punch. Blocking attendance entirely
because a CDN is unreachable is a worse failure than an unverified photo —
the admin review queue shows which punches were not checked, alongside the
measured brightness.

### 8.8 The photo carries its own evidence

Before upload, the image is stamped with a footer showing the employee's
name and event, the IST timestamp, and the latitude/longitude with accuracy.
The location is therefore visible **in the picture**, not only in the
database — which is what makes a screenshot of it worth anything.

### 8.9 Retention (1GB free tier)

Photos older than **90 days** are deleted and `selfie_path` cleared; the
attendance row itself is kept forever, so historic reports stay intact.

The sweep is folded into `/api/wfh-remind`, which already runs on both of
Hobby's two allowed cron slots — a twice-weekly sweep is ample for a 90-day
window. Override with `SELFIE_RETENTION_DAYS`.

Rough steady state: 24 people × 4 punches × 22 days × 60KB ≈ **380MB**.

## Step 9 — Leave & holidays

The point of this step is the attendance report. Before it, **Absent** meant
"no punch", which lumped together someone who skipped work, someone on
approved leave, and everyone on Diwali. After it, Absent means absent.

### 9.1 Run the migration

`supabase-leave-migration.sql` — creates `leave_types` (seeded CL / SL / EL /
Comp Off / LWP), `holidays`, and `leave_requests`.

### 9.2 Admin → 🌴 Leave

- **Leave requests** — filter by status; Approve / Reject on pending ones.
  The confirm spells out the consequence: approving means those dates read
  *On leave* rather than *Absent*.
- **Holiday calendar** — add a date, a name, optionally scoped to one company
  and optionally marked *Optional*. A company-specific entry wins over the
  all-companies one for that entity.

### 9.3 Employees

`/attendance` gains a **Leave** card: pick a type, dates, full or half day,
an optional reason. They can withdraw their own request while it is still
pending. The next few upcoming holidays are listed underneath.

### 9.4 How a day is decided

Order matters, and it is deliberate:

| Condition | Status |
|---|---|
| Any punch that day | Present (or No check-out) |
| Public holiday | Holiday |
| Approved leave | On leave / Half day leave |
| Optional holiday | Holiday |
| Not a working day on their shift | Week-off |
| Anything left | **Absent** |

Someone who punches in on a holiday is **Present**, not Holiday — they
worked. And a public holiday beats booked leave, so nobody burns a leave day
on a day the office was shut anyway.

### 9.5 Nobody can approve their own leave

RLS, not just UI:

- An employee may only insert a request **for themselves** and only with
  `status = 'pending'` — posting `status:'approved'` straight at the REST API
  is rejected by the policy.
- They may update their own request only **while it is still pending**, and
  only into `cancelled`.
- Approval runs through the admin API on the service_role key, and only acts
  on a row that is still pending — so a double-click cannot flip an already
  rejected request to approved.

A half day is constrained to a single date in the database as well as the UI.

---

### Vercel Hobby: the 12-function cap

A Hobby deployment may contain at most **12 serverless functions**, and this
project sits exactly on that line. Two consolidations keep it there:

- The attendance admin actions live in `api/admin.js` (prefixed `att_`)
  instead of their own file — it was already the password-gated action router.
- The shift actions live there too (prefixed `shift_`), for the same reason.
- The leave and holiday actions live in `api/admin.js` too (`leave_*` /
  `holiday_*`), and employees read/write their own leave straight through
  Supabase RLS rather than an endpoint.
- Selfie punches reuse `/api/attendance-webhook` with a Supabase user token
  rather than adding an endpoint, and the retention sweep rides along with
  `/api/wfh-remind` rather than taking a third cron slot.
- `api/send-verify.js` and `api/verify-code.js` were merged into
  `api/verify.js`. Both original URLs still work, via rewrites in
  `vercel.json`, so nothing on the front end changed.

**Before adding another endpoint, you must free a slot** (merge two related
handlers behind a rewrite) or move to a paid plan. A deployment with 13+
functions fails the build with
`No more than 12 Serverless Functions can be added to a Deployment on the Hobby plan.`

Cron slots are similarly full: Hobby allows 2, and both are used by
`/api/wfh-remind`.

## Admin session and URL

The admin page is `/wsm-admin`. The old `/admin` and `/Network.ADMIN` links redirect there. Support scripts and `/api/admin` keep their existing URLs.

After signing in, a signed HTTP-only, Secure, SameSite=Strict cookie keeps the admin session for 12 hours, including page refreshes. Lock clears the cookie and reloads the login screen. Changing `ADMIN_PASSWORD` or the Supabase service key invalidates existing sessions. No database migration or new environment variable is needed.

---

## Step 7 — Company default shifts

Each company has a default working window, used for anyone who has no shift
assigned to them personally:

| Company | Default shift |
|---|---|
| Jobways Point LLP | 6:00 PM – 3:00 AM (next day), Mon–Fri |
| Genie Lamp Private Limited | 6:00 PM – 3:00 AM (next day), Mon–Fri |
| Nova Sportsmart Private Limited | 9:00 AM – 6:00 PM, Mon–Sat |

These live in `company-config.js`, which is loaded by both the browser and the
serverless functions, so the attendance webhook, the admin reports, the employee
dashboard and the company-structure Gantt all resolve a shift the same way.

Order of precedence for one person:

1. The shift assigned to them in **Admin → Shifts**
2. Their company's default from the table above
3. The shift marked "General fallback" in **Admin → Shifts**

A company default is shown in the console as *"Company default"*; nothing needs
to be created in the Shifts table for it to apply.

---

## Step 8 — Retiring CORPGROUP

`CORPGROUP` is no longer a company. Everything on it moves to **Nova Sportsmart
Private Limited**, which already shared its sender mailbox and Bitrix group.

Run `supabase-corpgroup-retire-migration.sql` in the SQL Editor **before**
deploying, since the deployed code no longer knows how to route mail for
CORPGROUP. It remaps profiles, company policies, Bitrix targets, holidays and
history, and rewrites the allowed-company constraint. The last statement prints
a count per table — all four should be `0`.

Attendance, payroll, leave and assessment records are keyed on the person, not
on the company name, so nothing is lost.

---

## Step 9 — Admin console: onboarding, offboarding, import and audit

Run these two migrations, in order:

1. `supabase-admin-management-migration.sql` — employment details on profiles
   (department, job title, phone, joining date, manager) and the `mail_events`
   table behind **Email monitoring**.
2. `supabase-admin-console-migration.sql` — `profiles.status` / `exit_date` /
   `exit_reason` for offboarding, and the `admin_audit` table.

Both are safe to re-run and preserve existing records. Until they are applied
the console still loads: the affected fields are disabled and each panel says
which file to run.

### What the console gains

| Tab | What it does |
|---|---|
| **People → Company structure** | Company → department → employee, with each person's scheduled shift drawn on a 36-hour timeline so overnight shifts are visible. A schedule, not a punch record. |
| **People → Employees → + Add employee** | Creates the login account and the employee record together and emails an invite. No password is chosen by the admin or sent in plain text. |
| **People → Employees → 🚪** | Offboards someone: blocks the login, records a last working day, and drops them out of the live schedule. Their history is kept — this is not the 🗑️ delete button, which cascades their records away. ↩️ brings them back. |
| **People → Bulk import** | Paste or upload a CSV to create and update employees in bulk. Rows are matched on **email**. Always previews first and writes nothing until confirmed. |
| **Tools → Email monitoring** | Every outgoing message, its SMTP result, and whether each company's mailbox is configured. |
| **Tools → Audit log** | Every change made from the console — what changed, on whom, and whether it worked. Reads are not logged, and no passwords, codes or webhook URLs are recorded. |
| **Export CSV** (all tabs) | Downloads the rows currently on screen, with whatever filters are applied. |

### Bulk import CSV

Header row required. Recognised columns — anything else is ignored and named
back to you:

```
email,full_name,company,employee_code,department,job_title,phone,joining_date,is_wfh
```

`email` is required on every row and is what a row is matched on: an address
already in WorkSuite is **updated**, a new one **creates** an account and sends
an invite. An update never changes the login address. `joining_date` is
`YYYY-MM-DD`; `is_wfh` accepts `true`/`yes`/`1`. Use **Download template** for a
correctly-shaped starting file.

Rows are sent to the server in small batches so a large file does not hit the
10-second function limit — leave the tab open until it reports "Import
finished". Each row reports its own outcome, so one bad row never blocks the
rest.

### Notes

- Offboarding uses a long GoTrue ban to hold the login closed. If that call
  fails the console says so rather than assuming the person is locked out.
- The audit log records the caller's IP from `x-forwarded-for`. There is one
  shared `ADMIN_PASSWORD`, so it identifies the machine, not the person.

---

# CRM & work modules

WorkSuite now carries a full internal office platform on top of the tools
above: **CRM dashboard, Contacts, Leads, Deals, Messenger, Boards, Projects,
Tasks, Documents, Calendar, Employees and Invoices**. Everything is the same
architecture as before — static HTML/CSS/JS pages, Supabase behind Row Level
Security, and **no new serverless functions** (the deployment stays at 12 of
12 on the Vercel Hobby plan; both cron slots remain as they were).

## 1. Run the migrations (in this order)

Supabase → **SQL Editor → New query**, paste, **Run**. All four are idempotent
and only add: no existing table, row, user, message, punch or result is
changed. Do **not** run `supabase-full-reset.sql` — this is an upgrade.

| # | File | Adds |
|---|---|---|
| 1 | `supabase-crm-foundation-migration.sql` | `profiles.app_role` + a guard trigger, the `ws_*` permission helpers, `crm_activities`, `notifications`, `crm_contacts`, `crm_lead_statuses`, `crm_leads`, `crm_pipelines`, `crm_pipeline_stages`, `crm_deals`, `crm_convert_lead()`, manager read policies on `attendance_logs` and `leave_requests` |
| 2 | `supabase-work-migration.sql` | `task_statuses`, `boards`, `board_columns`, `projects`, `project_members`, `tasks`, `task_assignees`, `task_watchers`, `comments`, `document_folders`, `documents`, `document_links`, `calendar_events`, `event_participants`, the private **`documents`** storage bucket and its policies |
| 3 | `supabase-invoices-migration.sql` | `invoices`, `invoice_items`, `invoice_payments`, `invoice_counters`, database-owned totals, `invoice_duplicate()` |
| 4 | `supabase-messenger-migration.sql` | `conversations`, `conversation_members`, group / reply / edit / pin / mention columns on `messages`, `ws_unread_counts()` |
| 5 | `supabase-crm-reminders-migration.sql` | `crm_reminder_log`, `notifications.pushed_at`, `crm_run_reminders()` and a pg_cron schedule every 5 minutes (skipped with a notice where pg_cron is unavailable) |

**Already ran 1–4 before 11 Sep 2026?** Run all five again, in order. They
are idempotent, and 1–4 now carry fixes found by the real-database tests:

- A group message could be posted by someone outside the group. The original
  chat insert rule is now limited to direct messages.
- A lead with no owner could be converted by any colleague.
- Project members could not edit their own project.
- Deal close dates and invoice overdue status now use the IST calendar date.
- Session claims are read safely when they are empty.
- Calendar changes, conversations and memberships now update live.

**Changed again on 11 Sep 2026, after the first runs.** Re-run migrations 1
and 2; both are idempotent.

- **Migration 1:** converting a lead now files the new deal in the company's
  default pipeline. Before, an extra company pipeline such as "Renewals"
  captured it.
- **Migration 2:** the `documents` storage bucket now enforces the same file
  types as the upload dialog, not only the 50 MB limit.

Optional, **development projects only**: `supabase-crm-demo-seed.sql` creates a
few clearly-labelled sample records (all tagged `demo`) with a removal block
at the bottom. Never run it on production.

Until the migrations are applied every new page still loads and shows a
notice naming the file to run; the existing WorkSuite pages are unaffected.

## 2. Give someone a workspace role

Employees are `employee` by default and can only see their own company's
CRM/work records and edit what they own, created or are assigned. To finish
setup, promote at least one person:

Admin console (`/wsm-admin`) → **People → Employees → ✏️** → **Workspace role**:

| Role | Can additionally |
|---|---|
| `manager` | edit and delete any record in their company, configure pipelines, administer **Invoices**, read their company's attendance and approved leave (Employees → Attendance tab) |
| `admin` | the same across **every** company, and sees the Admin console link in the sidebar |

The role lives in `profiles.app_role`. Only the admin console (service key)
can change it: a database trigger rejects any change made with an employee's
own session, so it cannot be self-granted through the REST API. Payroll and
salary stay exactly where they were — visible only in the password-gated
admin console, to nobody else.

## 3. Routes

| URL | Module |
|---|---|
| `/crm/` | CRM dashboard (real counts and values, date / owner / company filters) |
| `/contacts/` · `/contacts/?id=…` | Contacts list · contact record |
| `/leads/` · `/leads/?id=…` | Leads · lead record, **Convert lead** |
| `/deals/` · `/deals/?id=…` | Deals pipeline (kanban / table) · deal record |
| `/chat/` (also `/messenger`) | Messenger — the existing chat, extended with groups, replies, edits, pins, search and mentions |
| `/boards/` · `/boards/?id=…` | Kanban boards |
| `/projects/` · `/projects/?id=…` | Projects |
| `/tasks/` · `/tasks/?id=…` · `/tasks/?view=mine` | Tasks (My / All / Created by me / Overdue / Due today / Completed, list or kanban) |
| `/documents/` · `/documents/?id=…` | Documents (private storage, signed URLs) |
| `/calendar/` | Calendar (month / week / day / agenda) |
| `/employees/` · `/employees/?id=…` | Employee directory and profiles (existing `profiles`) |
| `/invoices/` · `/invoices/?id=…` | Invoices (managers/admins) |

Every existing URL keeps working. `/chat/` is unchanged; `/messenger` is a
rewrite to it in `vercel.json`. `?new=1` on a list page opens the create
dialog (the command palette uses this).

## 4. Storage

One new **private** bucket, `documents` (50 MB per file), created by
`supabase-work-migration.sql`. Paths are `{uploader uid}/{uuid}-{safe name}`.
Uploads are allowed only into the caller's own folder; reads are allowed to
anyone who may see the matching `documents` row (same company); deletes to
the uploader or a manager. Files are served with 1-hour signed URLs, never a
public URL. The browser checks size and type (sniffing the first bytes, so a
renamed `.exe` is refused) and hashes each file so an identical upload links
to the existing copy instead of storing it twice. `chat-files`, `selfies` and
`wfh-recordings` are untouched.

## 5. Row Level Security

Every new table has RLS enabled with no blanket `USING (true)` on business
data (only the two lookup tables `crm_lead_statuses` and `task_statuses` are
readable by everyone). The rules, enforced in the database regardless of the
client:

- **Company isolation** — a record carries `company` (stamped from the
  creator's profile) and is visible only to people whose `company` or
  `company2` matches, or to admins.
- **Edit rights** — owner / creator / assignee / project member, or a
  manager of that company.
- **Delete** — managers, and for some records the creator (drafts, own
  comments). Archiving is the normal path; the UI confirms every deletion.
- **Calendar** — events marked private are visible to the owner and invitees
  only.
- **Invoices** — managers/admins of the company (plus read access for the
  creator). Line items cannot change once an invoice is sent; money columns
  are recomputed by triggers and client-sent totals are ignored.
- **Messenger** — group messages are visible to members only; only the author
  can edit a message; a member can only change their own read marker.
- **Notifications** — each person sees only their own.
- **Existing tables** — two additive policies let managers (and a person's
  `manager_id`) read `attendance_logs` and `leave_requests` for their people.
  Nothing an employee could see or do before has changed.

`tests/crm-migrations.test.js` checks these invariants statically (RLS on
every new table, idempotent DDL, no destructive statements).

## 6. Environment variables

No new variables. The modules use the existing `SUPABASE_URL`,
`SUPABASE_ANON_KEY` (via `/api/config`) and, for push notifications, the
existing `VAPID_*` keys behind `/api/push`. The service-role key is still
used only by the serverless functions.

## 7. Notifications

In-app notifications are rows in `notifications`, written by database
triggers (task assigned / completed / reopened, lead, deal and contact
assigned, deal won or lost, project added / status, meeting invited /
rescheduled / cancelled, group added, mentions). The bell in the top bar
lists them live; `notifications.js` shows the toast on any page; the acting
browser also fires the existing Web Push (`/api/push`) as fire-and-forget.
A notification that fails to deliver never rolls back the change that caused
it, and repeats of the same kind for the same record within an hour are
collapsed.

### Reminders (server-side)

`crm_run_reminders()` (migration 5) creates these whether or not anyone has
WorkSuite open, each exactly once:

| Kind | When | Who |
|---|---|---|
| Task reminder | the task's reminder time passes | assignee |
| Meeting reminder | inside the event's reminder window | organiser and invitees who have not declined |
| Lead follow-up | the follow-up time passes | lead owner |
| Daily digest | once a day from 09:00 IST, only if something is due | everyone with tasks due today or overdue |
| Invoice overdue | a sent invoice passes its due date (its status flips to overdue) | whoever raised it |

It runs every 5 minutes inside the database via pg_cron. It also runs twice
a day from the existing `/api/wfh-remind` cron, which pushes these reminders
to phones and laptops (Web Push). That adds no function and no cron slot.
For device pushes within minutes instead of twice a day, run the optional
`pg_net` block at the end of the migration. It needs the existing
`MAIL_API_KEY` pasted in.

### Emailing invoices

Managers can email a sent, part-paid, overdue or paid invoice from its page.
It goes to the invoice's billing email, falling back to the contact's email,
and "Send me a copy" adds your own address. A paid invoice goes out as a
receipt.

The request goes to the existing `/api/mail` handler with the manager's own
session token. The server loads the invoice, checks the role and company,
and builds the email itself, so the endpoint cannot be used to send anything
else. It uses the company's existing sender mailbox from `lib/mailer.js`. It
appears in **Admin → Email monitoring** (category `invoice`) and on the
invoice's activity timeline, which records only the recipient's domain.
Companies whose mailbox is still "coming soon" get a clear error.

## 8. Testing

```
npm test
```

runs the existing suites plus `tests/crm-logic.test.js` (IST dates and
ranges, invoice arithmetic, pipeline metrics, lead conversion planning,
duplicate detection, task due states, permissions, upload validation),
`tests/crm-migrations.test.js` (migration invariants) and
`tests/crm-roles.test.js` (workspace-role validation in the admin API),
`tests/crm-reminders.test.js` and `tests/invoice-mail.test.js`.

`tests/crm-database.test.js` runs **every migration on a real Postgres
engine** (PGlite, in-process, dev dependency) on top of a small Supabase
stand-in (`tests/fixtures/supabase-stub.sql`). It runs the CRM set twice to
prove it re-runs cleanly. It then checks the rules as signed-in employees, a
manager and an admin: company isolation, edit and delete rights, no
self-promotion, lead conversion, deal stages, tasks, projects and boards,
invoice arithmetic and payments, private meetings, document storage paths,
manager access to attendance and leave, salary privacy, group messages, and
reminders firing once.

It skips itself if `@electric-sql/pglite` is not installed. No test contacts
Supabase, SMTP or a push service. One test walks the spec's section-27
acceptance scenario end to end:

1. a lead is assigned, worked and converted;
2. the deal is moved to Won;
3. a task goes to a colleague and appears on the calendar;
4. a project gets members, a board and a document;
5. a meeting is scheduled;
6. an invoice is raised with correct totals;
7. the timeline and notifications are checked.

### Browser smoke test (opt-in)

```
npm run smoke:ui
```

This opens every page in the installed Chrome, at desktop and phone width,
signed in as a fictional manager. It serves the repository the way Vercel
does and answers Supabase from fixture data (`tests/ui-smoke/fixtures.js`),
so it needs no project and no network apart from the script CDNs.

A page fails on:
- an uncaught script error
- a "could not load" state on screen
- a missing app shell
- sideways scrolling on a phone

It also opens the new-contact dialog, searches from the command palette, and
checks that the pipeline, task list, calendar and invoice total render.
Screenshots land in `tests/ui-smoke/out/`, which git ignores. Set
`CHROME_PATH` if Chrome is not in the usual place. It uses `puppeteer-core`
(a dev dependency) and never downloads a browser.

## 9. Deployment

Deploy as before. The function count is unchanged (12), the cron count is
unchanged (2), and the only `vercel.json` change is the `/messenger` rewrite.
Apply the four migrations **before** or **after** deploying — the pages
degrade to a "run the migration" notice until they exist.
