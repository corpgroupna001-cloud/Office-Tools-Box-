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
| `https://work-suite-mauve.vercel.app/Network.ADMIN` | Admin dashboard — password required |

---

## Testing

1. Visit `/typingtest/` → sign up with your email + password
2. Complete a test → you should see the "Download Result" button and a saved record in Supabase (`test_results` table)
3. Visit `/Network.ADMIN` → enter your `ADMIN_PASSWORD` → you should see your test result

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

---

### Vercel Hobby: the 12-function cap

A Hobby deployment may contain at most **12 serverless functions**, and this
project sits exactly on that line. Two consolidations keep it there:

- The attendance admin actions live in `api/admin.js` (prefixed `att_`)
  instead of their own file — it was already the password-gated action router.
- The shift actions live there too (prefixed `shift_`), for the same reason.
- `api/send-verify.js` and `api/verify-code.js` were merged into
  `api/verify.js`. Both original URLs still work, via rewrites in
  `vercel.json`, so nothing on the front end changed.

**Before adding another endpoint, you must free a slot** (merge two related
handlers behind a rewrite) or move to a paid plan. A deployment with 13+
functions fails the build with
`No more than 12 Serverless Functions can be added to a Deployment on the Hobby plan.`

Cron slots are similarly full: Hobby allows 2, and both are used by
`/api/wfh-remind`.
