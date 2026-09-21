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
the webhook **derives** the direction from the gaps between punches and the
person's shift. Rows derived this way carry `direction_derived = true`. The
rules live in `lib/attendance.js` (`assignDays`), and
`tests/attendance-days.test.js` spells them out case by case.

**Which day a punch belongs to**

- **The gap between punches decides first.** A punch less than 8 hours after
  the one before is the same day: the person is still at work, however late
  that runs. The one exception is a real pause: after 4 hours or more
  without a punch, a punch from 2 hours before their next shift starts is
  that shift's arrival and opens a new day.
- **A silence of 8 hours or more starts a new day**, except inside the day's
  own shift window. Each date's shift owns the 24 hours around it, half the
  off-hours on either side, so a 6 PM – 3 AM shift owns 10:30 AM to 10:30 AM
  the next morning. Inside that window the day carries on across a long
  silence in two cases only:
  - the end of a shift worked without break punches, up to 4 hours after the
    shift end: 6 PM in and 3:02 AM out, nine hours apart, is one night;
  - a return later the same calendar day: back from lunch at 2 PM, out at
    10:30 PM.
- **A new day is dated by the shift it could still be.** A 12:30 AM late
  arrival for a 6 PM shift belongs to the evening before, and so does a
  3:02 AM Logout whose Login was never punched. More than 4 hours past that
  shift's end it cannot be that shift, and the day takes the calendar date.
- **A wrong shift mostly costs labels, not dates** - the gaps decide, and the
  shift only bridges a silence inside its own window - with one exception
  that follows from the rule above: a day whose first punch comes within 4
  hours after the shift's end is filed under that shift's day. On a night
  shift, **the Jobways and Genie Lamp 6 PM – 3 AM default included**, a day
  that starts between midnight and 7 AM therefore lands on the evening before.
  Right for a late arrival or a logout with no login; wrong for someone who
  really starts work before 7 AM. **Give anyone who does not work their
  company's default hours a shift of their own** (Admin → Shifts), then
  recompute them (see below).
- **Without a shift** (a code not yet bound to anyone), the gap is all there
  is, and punches simply alternate from IN. Binding the code re-derives them
  with the person's real shift.

**IN or OUT, and Login / Break / Logout**

- **The day's first punch is the Login**, unless it is at the shift end (from
  the end, less the early-out grace, up to 4 hours after it). Then it is the
  **Logout**, and the day shows the login as missing rather than a Login
  "9h late".
- **After that, each punch is the opposite of the one before it**: after an IN
  an OUT, after an OUT an IN. A missed punch costs one label; it does not flip
  the rest of the day.
- **An OUT before the shift end is a Break out, one at or after it (less the
  early-out grace) the Logout.** A later punch the same day settles it as a
  break after all; and once the person's next day has begun, their last OUT
  was the Logout however early it was.
- **A punch at or after the shift end, more than 2 hours after a Break out, is
  the Logout**: the return from that break was never punched. It is not a
  "Break in".
- **Those two guesses at the shift end are taken back if the day would then
  end on an IN.** Someone who came in at the end of the day and stayed on, or
  whose "missed return" was a long errand after all, gets plain alternation
  from the Login instead, so the day is not left without an Out.
- **A second touch within 2 minutes is the same punch** (a double tap, or the
  reader seeing someone linger). It is stored, with the labels of the punch it
  repeats, and ignored everywhere else: it is not emailed or posted to Bitrix,
  it neither opens nor closes a day, and the calendar, the reports, the pay
  sheet and the automatic Logout all skip it.

**A day nobody closed**

- **From 30 minutes after the shift end**, someone still logged in counts as
  logged out **at the shift end**, and someone still on a break that began
  before the end counts as logged out **at that break**. The automatic Logout
  posted to the group and the screens (the calendar, the daily report, the
  pay sheet) all count it that way from that same moment, not before: plenty
  of people leave 10–20 minutes late. The post comes from the scheduler; see
  *The scheduler* under "Attendance → Bitrix24" below.
- **Anything punched after the shift end is overtime** (a login, a return, a
  break started late) and gets no automatic Logout. If such a day ends on an IN
  and the person then goes 8 hours without a punch, the screens take that last
  punch as the day's Out.

**After deploying these rules**, relabel the punches already stored:
Admin → 🕐 Attendance → **Attendance days**, pick the range, **Check** to see
what would change, then **Apply changes**. Check reads the range page by page
- up to about 20,000 punches, the day and a half either side included; past
that it says where it stopped, and you run it again from that date. One
press of **Apply changes** writes up to 300 changes; while some are left,
press **Check** and then **Apply changes** again until Check finds nothing.
It only relabels stored punches. Nothing is emailed or posted to Bitrix
again.

**Attendance days re-judges everyone in the range** against the shift each
person has *today*, unless you type one person's **Biometric ID** into it.
WorkSuite keeps each person's current shift, not a history of them. So:

- **One person's shift on record was wrong**, and they always worked those
  hours (a night worker left on the day shift, say): fix the shift, then
  recompute the past weeks **with their Biometric ID**.
- **Someone's hours really changed** (nights until the 14th, days from the
  15th): recompute them only **from the first day they worked the new
  hours**, never from the morning their last night ended - a range reaching
  back before it judges the old shift's days against the new hours. New
  punches do not rewrite the old days on their own: a punch after a silence
  of 8 hours or more leaves the days before that silence as they were.
- **The deploy relabel above** covers everyone: pick a range that starts
  after the most recent real change of hours of anyone in it, and relabel
  anyone whose hours changed inside it on their own, from their change date.

Other things worth knowing:

- Because direction is computed, it is deliberately **not** part of the
  dedupe key — that is `(employee_code, log_datetime, device_sn)`. Were
  direction included, a recomputed direction would insert a second row for the
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
- Replays are ignored: `(employee_code, log_datetime, device_sn)` is unique,
  so re-exporting a date range inserts nothing and emails nothing.
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
The whole shift is one attendance day, dated by the evening it starts, and a
punch at its end is the Logout, not the next day's Login (see §6.3a).

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
`/api/wfh-remind`. The attendance scheduler (shift-end Logouts, the dual-shift
switch, Bitrix retries) runs from pg_cron inside Supabase instead, and calls
the existing `/api/attendance-webhook`, so it needs neither a slot nor a
function. `vercel.json` gives that function 60 seconds, and `/api/admin` too,
whose **Run now** button waits on a run (`functions` → `maxDuration`, allowed
on Hobby, adds no function), so a busy run is not cut off at the 10-second
default.

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

### Attendance → Bitrix24: delivery and shift-end logouts

Run `supabase-attendance-scheduler-migration.sql` (next section). It carries
everything `supabase-attendance-bitrix-migration.sql` adds, so that file is
optional now; running it as well does no harm. Every punch then records whether
its group message went (**Admin → Attendance**, Bitrix column, with the reason
when it did not).

The scheduled call (`worksuite-shift-switch`, every 5 minutes,
`?job=shift_switch`) does three things:

- at a dual-shift person's second shift start, if they are still at work on a
  day they began with the first company, posts the Logout to the first
  company's chat and the Login to the second's (once per person per day);
- sends again the punches Bitrix did not take (failed or out of time) — up to
  4 attempts, within 6 hours of the punch;
- closes a shift nobody logged out of: 30 minutes after the shift ends, someone
  still logged in is posted as **Logout at the shift end** ("shift ended without
  a punch-out"), and someone still on a break that began before the end as
  **Logout at that break** ("did not return from break by shift end"). Once per
  person per day, and only within 12 hours of the shift end; a post Bitrix
  refused is sent again up to 3 times within 6 hours, unless the person has
  punched since. Anyone who punched after the shift end is on overtime and is
  left alone, and a repeat tap counts as neither a punch-out nor a return.
  The calendar, the daily report and the pay sheet count the day the same way,
  from the same moment: it ends at the shift end, or at that break, from 30
  minutes after the end, whether or not the post went out (§6.3a, *A day
  nobody closed*).

#### The scheduler: run `supabase-attendance-scheduler-migration.sql` once

All three ride on one pg_cron job inside Supabase, so it takes no Vercel cron
slot and no function. Supabase → **SQL Editor** → paste all of
`supabase-attendance-scheduler-migration.sql` → **Run**. As-is: **there is no
key to paste.** The migration generates a secret inside the database (the
single row of `worksuite_scheduler`, readable by the service key only); the job
sends it with every call, and the webhook checks it against that same row. The
file also adds anything the jobs need from the dual-shift and attendance-bitrix
migrations, so it works whether or not those were run, and it is safe to run
again — the secret is kept and the job is replaced, never doubled. Deploy the
webhook that checks that secret first: until it is live, the new job's calls
get 401, and the status below says so.

Why this matters: `supabase-dual-shift-migration.sql` used to schedule this job
with the header `Bearer PASTE-YOUR-BIOMETRIC_API_KEY`. Run without editing it,
every call was refused with 401 — so no shift-end Logout was ever posted and no
dual shift switched. That file no longer touches the scheduler, so re-running it
cannot put the broken job back.

**Checking it works.** Give it 5 minutes after running, then:

- Admin → 🕐 Attendance shows the scheduler status: the job, its last runs, the
  last answers from the webhook, and in plain words anything that is wrong, with
  a button to run the job once straight away. No problems listed means the job
  exists, sends the stored secret, and the webhook has recorded a scheduled run
  in the last 15 minutes.
- Or in the SQL Editor:

  ```sql
  select public.worksuite_scheduler_status();
  select status_code, timed_out, error_msg, created
    from net._http_response order by created desc limit 10;
  ```

  `200` is the webhook answering; `401` means the key it was sent is wrong.
  The status (and so the admin panel) only counts answers that came after the
  migration last scheduled the job (`worksuite_scheduler.scheduled_at`), so the
  401s the old placeholder job collected are not blamed on the new one. In the
  raw `net._http_response` list, rows from before you ran the file are the old
  job's.
- `select last_run_at, last_job, last_ok, last_result from public.worksuite_scheduler;`
  is the webhook's own note of the last scheduled call and what it did
  (switches, retries, automatic Logouts).
- `cron.job_run_details` on its own is **not** proof. `succeeded` there only
  means pg_cron queued the request; it said `succeeded` the whole time the
  webhook was answering 401.

If WorkSuite moves to another address:
`update public.worksuite_scheduler set site_url = 'https://…' where id = 1;` —
the next run uses it, nothing to reschedule. To stop the job:
`select cron.unschedule('worksuite-shift-switch');`.

After a full data reset (`supabase-full-reset.sql`, Section 2), the job is
still scheduled but its row is gone, so it calls nobody while
`cron.job_run_details` keeps saying `succeeded`. Run
`supabase-reseed-after-reset.sql` (or this migration again) to put the row
back; it gets a new secret, which the job and the webhook both pick up without
anything to paste. The reset's Section 2b ("keep the configuration") leaves
the row alone.

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
| **People → Employees: Employee ID and Biometric ID** | **Employee ID** (migration 9) is the ID a person is known by and is shown first everywhere — CRM people, pickers and filters, chat mentions and colleague lists, the directory, the command palette. **Biometric ID** is the fingerprint reader's enrolment number (`employee_code`) that punches match on. Both are set in Add / Edit employee and the bulk import (`employee_id`, `employee_code` columns). CRM import matches the Responsible person on Employee ID first. |
| **CRM → Deals / Leads** | Every deal and lead in the columns of the Bitrix24 file it was imported from, filtered by pipeline, stage, status and responsible person, a page at a time. **Columns** picks what the table shows; a click opens the whole record. **Export CSV** downloads every matching record in the export's own format (quoted cells, semicolons, byte-order mark), so it reads back into Bitrix24 or CRM import. A deal moved or edited in WorkSuite exports as it is now. Needs migration 8. |
| **CRM → CRM import** | Deals or leads from a Bitrix24 export, as it comes. Every column is kept. Pipelines, stages and lead stages the file names are created; rows with an ID update the same record when imported again. |
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

Supabase → **SQL Editor → New query**, paste, **Run**. All of them are idempotent
and only add: no existing table, row, user, message, punch or result is
changed. Do **not** run `supabase-full-reset.sql` — this is an upgrade.

| # | File | Adds |
|---|---|---|
| 1 | `supabase-crm-foundation-migration.sql` | `profiles.app_role` + a guard trigger, the `ws_*` permission helpers, `crm_activities`, `notifications`, `crm_contacts`, `crm_lead_statuses`, `crm_leads`, `crm_pipelines`, `crm_pipeline_stages`, `crm_deals`, `crm_convert_lead()`, manager read policies on `attendance_logs` and `leave_requests` |
| 2 | `supabase-work-migration.sql` | `task_statuses`, `boards`, `board_columns`, `projects`, `project_members`, `tasks`, `task_assignees`, `task_watchers`, `comments`, `document_folders`, `documents`, `document_links`, `calendar_events`, `event_participants`, the private **`documents`** storage bucket and its policies |
| 3 | `supabase-invoices-migration.sql` | `invoices`, `invoice_items`, `invoice_payments`, `invoice_counters`, database-owned totals, `invoice_duplicate()` |
| 4 | `supabase-messenger-migration.sql` | `conversations`, `conversation_members`, group / reply / edit / pin / mention columns on `messages`, `ws_unread_counts()` |
| 5 | `supabase-crm-reminders-migration.sql` | `crm_reminder_log`, `notifications.pushed_at`, `crm_run_reminders()` and a pg_cron schedule every 5 minutes (skipped with a notice where pg_cron is unavailable) |
| 6 | `supabase-b24-migration.sql` | The Bitrix24-style workspace: company structure, CRM access roles, customer companies, custom fields, products, automation, project privacy, task views, whiteboards, document sharing and public links, calendar colours, per-person list settings — see [11. The Bitrix24-style workspace](#11-the-bitrix24-style-workspace) |
| 7 | `supabase-messenger-calls-migration.sql` | Messenger & calls v2: `messages.client_id`, `ws_chat_inbox()`, `calls`, `call_participants` and the `ws_call_*` functions — see [10. Messenger & calls](#10-messenger--calls) |
| 8 | `supabase-crm-import-migration.sql` | CRM import: `external_ref` (the Bitrix24 id, so importing a file again updates instead of duplicating), `source_row` (every filled-in cell of the record's row) on `crm_deals` and `crm_leads`, and `crm_import_layouts` (the file's columns, in order) — behind **Admin → CRM → Deals / Leads** |

| 9 | `supabase-employee-id-migration.sql` | `profiles.employee_id` — the Employee ID people are known by (GL-PIS-CSM-IC-001), unique whatever the case and set only by an administrator. Shown first across the CRM, chat mentions, the directory and the admin console. `employee_code` is unchanged and is labelled **Biometric ID** |
| 10 | `supabase-crm-sales-migration.sql` | Sales: quotes (`crm_quotes`, `crm_quote_items`, `crm_quote_from_deal()`, `crm_quote_to_invoice()`), lost reasons (`crm_lost_reasons`, `crm_deals.lost_reason`), monthly sales targets (`crm_sales_targets`) and public web-to-lead forms (`crm_web_forms`, `crm_web_form_submit()`) — see [12. Sales: quotes, forecast and web forms](#12-sales-quotes-forecast-and-web-forms) |
| 11 | `supabase-security-hardening-migration.sql` | Security guards, no data changes — see [13. Security hardening](#13-security-hardening). **Run it together with the deploy that carries it**: the sign-in page and the API were changed to match |
| 12 | `supabase-crm-all-companies-migration.sql` | CRM access across companies: a sixth access level, **All companies**, and a role *Full CRM access (every company)* assigned to nobody. See [14. CRM access across companies](#14-crm-access-across-companies) |
| 13 | `supabase-task-summary-migration.sql` | `tasks.result_required`: Bitrix24's *Task status summary is required* on the new-task page |

**Ran migration 8 before 15 Sep 2026?** Run it again. Its first version made
`external_ref`'s unique index partial, which `ON CONFLICT` cannot use, so every
import batch failed with *"there is no unique or exclusion constraint matching
the ON CONFLICT specification"* (shown as "The import stopped part way").

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
| `/companies/` · `/companies/?id=…` | Customer companies |
| `/crm/settings` | CRM settings: access permissions, custom fields, lead stages, automation, products (managers) |
| `/leads/` · `/leads/?id=…` | Leads · lead record, **Convert lead** |
| `/deals/` · `/deals/?id=…` | Deals pipeline (kanban / table) · deal record |
| `/chat/` (also `/messenger`) | Messenger — direct and group chat, voice notes, files, replies, edits, pins, search, mentions and call history. Deep links `#thread=<userId>`, `#group=<id>`, `#call=<callId>` |
| `/call/?id=…` | The call window (voice, video, screen share), opened by Messenger or an incoming-call banner |
| `/boards/` · `/boards/?wb=…` · `/boards/?tab=kanban` · `/boards/?id=…` | Whiteboards (list and editor) · Kanban boards |
| `/projects/` · `/projects/?id=…` | Projects |
| `/tasks/` · `/tasks/?id=…` · `/tasks/?view=mine` | Tasks (My / All / Created by me / Overdue / Due today / Completed, list or kanban) |
| `/documents/` · `/documents/?id=…` | Documents drive: files and folders (private storage, signed URLs), WorkSuite documents, spreadsheets and presentations, sharing, Recycle bin |
| `/documents/public?t=…` | A document someone published with a public link (read-only, no sign-in) |
| `/calendar/` | Calendar (day / week / month / schedule, invitations, .ics import and export) |
| `/employees/` · `/employees/?id=…` | Find employee and profiles (existing `profiles`) |
| `/employees/structure/` | Company structure (org chart) |
| `/invoices/` · `/invoices/?id=…` | Invoices (managers/admins) |
| `/quotes/` · `/quotes/?id=…` | Quotes: every quote belongs to a deal; accepted quotes become invoices |
| `/crm/forecast` | Sales forecast: closed / commit / best case / weighted pipeline per month, targets, win-loss and lost reasons |
| `/form/?f=…` | A public web-to-lead form (no sign-in; CRM settings → Web forms) |

Every existing URL keeps working. `/chat/` keeps its address and its deep
links; `/messenger` is a rewrite to it in `vercel.json`. `?new=1` on a list page opens the create
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

No new required variables. Optional: `SMTP_TLS_STRICT=1` makes the mailer
verify the SMTP server's certificate (set `SMTP_TLS_SERVERNAME` to the name on
the certificate if it is not `SMTP_HOST`) — see [13. Security hardening](#13-security-hardening). The modules use the existing `SUPABASE_URL`,
`SUPABASE_ANON_KEY` (via `/api/config`) and, for push notifications, the
existing `VAPID_*` keys behind `/api/push`. The service-role key is still
used only by the serverless functions. Calls work without anything new; a
free TURN relay for strict firewalls is optional — see
[10. Messenger & calls](#10-messenger--calls).

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

It checks scrolling too:
- **Messenger:** a long chat opens at its newest message, the header and the
  message box stay on screen, and the page never scrolls behind the chat.
  Scrolling up loads earlier messages without losing your place, and date
  labels never cover a message.
- **Typing test:** its page scrolls again once its dialogs close.
- **Every page:** audited for content cut off with no way to scroll to it,
  and for a large scroll area nested inside another (two scrollbars
  competing). These findings print as notes; `SMOKE_SCROLL=1` makes them fail
  the run.

`SMOKE_BIG=1 npm run smoke:ui` fills every list with far more rows than fit
on a screen, which is where scrolling problems show up. That covers people,
chats, contacts, leads, deals, tasks, documents, meetings and notifications.
To run only some pages, pass their names:
`node tests/ui-smoke/smoke.js messenger calendar-week`.

Screenshots land in `tests/ui-smoke/out/`, which git ignores. Set
`CHROME_PATH` if Chrome is not in the usual place. It uses `puppeteer-core`
(a dev dependency) and never downloads a browser.

## 9. Deployment

Deploy as before. The function count is unchanged (12), the cron count is
unchanged (2), and the only `vercel.json` changes are the `/messenger`
rewrite and `/api/ice` (a rewrite to the existing `/api/push`, not a new
function). `.vercelignore` keeps `tests/` off the site.
Apply the migrations **before** or **after** deploying — the pages
degrade to a "run the migration" notice until they exist.

# 10. Messenger & calls

Messenger (`/chat/`) and calling were rebuilt in September 2026. Chat keeps
every existing message, group, reaction and file; nothing is migrated or
lost. Calls are new: the old version sent every call's connection details to
every open WorkSuite page and dropped most calls that crossed a firewall.

## Run the migration

Supabase → **SQL Editor** → paste `supabase-messenger-calls-migration.sql` →
**Run**. Run it seventh, after `supabase-b24-migration.sql`. It is
idempotent and only adds:

- `messages.client_id`, which lets a message be retried after a dropped
  connection without being sent twice;
- `ws_chat_inbox()`, which loads the conversation list in one call;
- `calls` and `call_participants` (read-only from the browser, with every
  change made by the `ws_call_*` functions);
- live updates for both call tables;
- **private chat attachments**. The old `chat-files` policy let any signed-in
  user read or list every file in the bucket. A file is now readable only by
  the person who uploaded it and by people who can see the message it was
  sent in. Clearing a chat or deleting a message for everyone also removes
  access to its file.

Until it runs, Messenger still works on the older queries. The call buttons
say "Calls are not set up yet" and name this file.

## How calls work

- **Voice and video calls, 1:1 or in a group of up to 8.** You can also share
  your screen, switch camera, microphone or speaker, and turn video on or off
  during the call. Group calls add every member, and anyone in the group can
  join while the call is live.
- **Ringing.** Every WorkSuite page you have open rings, and so does every
  device with notifications on (Web Push, using the existing `VAPID_*` keys),
  even with the browser closed. Answering on one device stops the others. The
  call opens in its own window, so you can keep working in WorkSuite during it.
- **The database is the source of truth.** An unanswered call rings for 45
  seconds. A browser that disappears (closed tab, laptop asleep) drops out of
  the call after 40 seconds. When a call ends, the database writes it into the
  conversation once. People who missed it get a bell notification. Someone
  already on a call is shown as busy and their phone doesn't ring.
- **Privacy.** Audio and video go straight from browser to browser, encrypted
  (WebRTC, DTLS-SRTP), and are never recorded. Supabase only stores who
  called whom, when, and for how long. The connection details for each call
  travel on a channel named after that call's id, and only the people in the
  call can read that id.

## Calls behind strict firewalls: a free TURN relay (optional)

On most home and office networks two browsers connect directly using public
STUN servers, with no setup. Some corporate firewalls and mobile carriers
block that direct path, and those calls need a **TURN relay**. Configure one
of these; all three can be used for free. Set the variables in **Vercel →
Settings → Environment Variables** and redeploy. The first one configured is
used.

| Option | How to get it | Variables |
|---|---|---|
| **Cloudflare Realtime TURN** (free monthly allowance) | Cloudflare dashboard → **Realtime** → **TURN Server** → *Create* → copy the *Turn Token ID* and the *API Token* | `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` |
| **Metered / Open Relay** (free plan) | Sign up at metered.ca → create an app → **TURN Server** → copy the API key; the domain is `<your-app>.metered.live` | `METERED_TURN_DOMAIN`, `METERED_TURN_API_KEY` |
| **Your own coturn** (free software) | Run coturn with `use-auth-secret` and a `static-auth-secret` | `TURN_URLS` (e.g. `turn:turn.example.com:3478,turns:turn.example.com:5349`), `TURN_SECRET` — or static `TURN_USERNAME` + `TURN_CREDENTIAL` |

Optional: `TURN_TTL_SECONDS` sets how long relay credentials last. The
default is 12 hours, and values are capped between 10 minutes and 48 hours.

Browsers get short-lived credentials from `GET /api/ice`, and only with their
own session token. The secrets stay in Vercel. To check the setup, open any
call. A connection that goes through the relay shows "via relay" in the
call's connection details. You can also call the endpoint directly with a
session token:

```
curl -H "Authorization: Bearer <access_token>" https://<your-site>/api/ice
```

It should answer with `"relay": true` and the provider's name. If a provider
fails, it falls back to STUN: calls on open networks still connect.

## Messenger

Everything from before is still there:

- direct and group chats, with group admin, mute, leave and archive;
- replies, edits, delete for everyone, pins, search and @mentions;
- reactions, files and photos (private `chat-files` bucket), link previews;
- read receipts, typing indicators and online status;
- WFH / leave chips next to names.

Also fixed or new:

- Threads open on the **newest** messages. Older ones load as you scroll up.
  Before, only the first 200 messages ever sent were loaded.
- Messages you send appear on your other devices. After sleep, a dropped
  connection or going offline, the open conversation and the list re-sync.
  Anything you sent while offline is sent when you're back, never twice.
- Sending shows each message's state: sending, sent, read, or failed (with
  retry).
- New: multi-line messages, paste or drag-and-drop files with upload
  progress, voice messages, an emoji picker, "Seen by" in groups, and a
  **Calls** tab with your call history.
- Push notifications for messages and calls are written by the server from
  the database (`/api/push` `message` / `call` / `call-end`), so a browser
  can't send a notification in someone else's name. A message notification
  and the page's own notification share a tag, so only one shows.

## Tests

`npm test` includes:

- `tests/messenger-calls-database.test.js`, which runs every call rule on a
  real Postgres: visibility, ringing, answering, declining, cancelling,
  time-outs, busy, device takeover, group calls, the single call-log line and
  the missed-call bell;
- `tests/push-api.test.js` and `tests/comms-push.test.js`, which check who
  may push what to whom;
- `tests/ice-servers.test.js`, which checks TURN provider selection and
  fallbacks;
- `tests/chat-logic.test.js`, which covers message formats, previews and
  grouping.

`npm run test:calls` (Chrome required, like `smoke:ui`) connects two, then
three, real WebRTC peers in one browser with a fake camera and microphone.
It checks every connection, camera on and off, ICE restart, recovery from a
lost offer, and late joiners. `npm run smoke:ui` now also opens the call
window.

## 11. The Bitrix24-style workspace

`supabase-b24-migration.sql` is run **sixth**: after re-running 1 and 2, and
before `supabase-messenger-calls-migration.sql`. Like the others it is
idempotent and only adds; running it twice changes nothing.

| Area | What it adds |
|---|---|
| Company structure | `departments` and `department_members` (seeded once from each profile's company and department), `profiles.invited_at` |
| CRM access | `crm_roles`, `crm_role_permissions`, `crm_role_assignments`, seeded **Employee** and **Manager** roles that reproduce the earlier rules, `ws_crm_levels()` and the row checks behind the RLS on contacts, companies, leads, deals and invoices |
| CRM data | `crm_companies`, record numbers, `crm_custom_fields` and a `custom` column on each record, `crm_products` and `crm_deal_products`, `crm_automation_rules` |
| Projects and tasks | project privacy and join requests, `task_planner`, `task_views`, `task_templates` |
| Boards | `whiteboards`, `whiteboard_shares` |
| Documents | private / company / shared documents, `document_shares`, WorkSuite documents, spreadsheets and presentations (stored as JSON on the row), public links: `ws_published_document()` and a public `published` bucket |
| Calendar | `calendar_events.color` |
| Settings | `user_ui_settings` (list columns, saved filters, the left menu, per person), `workspace_settings` |
| Feed | `feed_posts`, `feed_comments`, `feed_reactions`, `feed_post_views` (no page shows them yet) |

**Before it has run** every page still works: lists fall back to the earlier
columns, CRM access follows the earlier employee / manager rules, Boards shows
a notice while Kanban boards keep working, Documents handles files and folders
only, the calendar has no event colours, and Company structure draws a
read-only chart from the profiles.

**After running it:**

1. **CRM → Settings → Access permissions:** check the two seeded roles; they
   match the old behaviour until you change them.
2. **Employees → Company structure:** departments were created from the
   profiles. Choose heads and move people where needed (managers for their
   company, admins for the whole group).
3. **Public links** need no set-up. The `published` bucket is public on
   purpose: a file is copied into it only when someone turns its link on, and
   removed when they turn it off. WorkSuite documents are read through
   `ws_published_document()`, which returns nothing once the link is off or
   the document is in the Recycle bin.

# 12. Sales: quotes, forecast and web forms

Run `supabase-crm-sales-migration.sql` (migration 10). Until it runs, the
new pages show a notice naming the file and the deal page works as before.

**Quotes** (`/quotes/`, and **Create quote** / the **Quotes** tab on a deal).
A quote always belongs to a deal, as in Salesforce, and follows the deal's
access: whoever can read the deal reads its quotes, whoever can edit the deal
writes them. **Create quote** copies the deal's customer, currency and
product lines (or one line for the amount when it has no products). Numbers
are `Q-<year>-<0001>` per company; totals are computed by the database with
the invoice formulas. Draft → **Mark sent** (lines lock) → **Accepted** or
**Declined**; a sent quote past its *valid until* date reads as *Expired*.
**Accepted** can set the deal amount to the quote total, and **Create
invoice** turns it into a draft invoice once (it needs *Invoices: add*).

**Lost reasons.** Marking a deal lost (stage move, kanban drop or the card
menu) asks why; the reason and a note are kept on the deal and cleared if it
is reopened. Eight shared reasons come with the migration; add your own in
**CRM settings → Lost reasons**.

**Sales forecast** (`/crm/forecast`). Per month, from real deals in one
currency: *Closed won* (won and closed that month), *Commit* (open, expected
that month, probability ≥ 70%), *Best case* (every open deal expected that
month) and *Weighted pipeline* (value × probability). Open deals with a past
or no expected close date are counted separately so they are not lost.
Managers set a monthly **target** per person (click *Set* in *This month by
person*); attainment is closed ÷ target. *Win / loss* covers the last 90 days
with the win rate, the average days to win and the lost reasons ranked.

**Web-to-lead forms** (**CRM settings → Web forms**). Choose the fields, who
the leads go to, the source and a thank-you message or an https redirect,
then share the link or paste the embed code (an iframe) into your website.
Each submission becomes a lead owned by that person, who gets the usual
*Lead assigned* notification. The page is `/form/?f=<token>` (the token is
32 random characters). It calls only `crm_web_form_public()` and
`crm_web_form_submit()`, the two functions an anonymous visitor may run; the
submit function keeps only the form's fields, trims and validates them,
drops bots that fill a hidden field, and allows 5 submissions per visitor per
10 minutes and 300 per form per hour.

# 13. Security hardening

A review of the API and the database found holes that `supabase-security-hardening-migration.sql`
(migration 11) and the same deploy close. Run the migration right after deploying.

| What could happen | Now |
|---|---|
| A notification (bell item, toast, push) could carry a `javascript:` or off-site link, so one click ran script in the victim's session | Links must be in-app paths (`/…`): the database blanks others, the pages and the service worker refuse them, `/api/push` replaces them |
| Anyone could change their own `company2`, manager, shift, biometric ID, WFH flag, status, HR fields or email on their profile — `company2` shows another company's CRM data | A trigger allows those only through the admin console. The company is chosen once, at first sign-in; after that an administrator moves people. **My profile** no longer offers a company picker |
| `/api/send-verify` and `/api/verify-code` trusted a `user_id` from the request: anyone could change someone's company or verify an email they do not own | Both need the caller's session and work only on that account; the company is read from the profile. Codes are sent at most once a minute |
| Employees could approve their own WFH clip QC | A trigger keeps QC fields for reviewers; every new clip goes back to *pending* |
| Anonymous visitors could call internal functions (`crm_log`, `ws_notify`, invoice numbering) and write into any company's timeline | Revoked; `crm_log` writes only into the caller's own company; invoice numbers are drawn only by the invoice trigger |
| Signup codes were readable and resettable by the account | Server-only |
| Someone removed from a group could re-share its files to themselves | A message may carry a file only if its sender can see that file now (forwarding still works) |
| `/api/linkpreview` could be pointed at internal addresses (redirects, IPv6-mapped and DNS names) | Signed-in callers only; every connection, including redirects, refuses private, loopback, link-local and CGNAT addresses at connect time |
| `/api/groq` and `/api/quiz` were open to the internet (our Groq quota) | Signed-in callers only |
| `signup-complete` accepted any company; `signup-start` could mail any address in a loop | The company list is checked again; one code per address per minute |
| Admin password, mail key and cron secrets were compared with `===` | Constant-time comparison |
| Malformed JSON crashed several functions with a 500 | 400 *Invalid JSON* |

**SMTP certificate.** The mailer still skips certificate checks by default,
because cPanel mail servers often present a certificate for the server's own
name and turning it on blindly would stop all email. Once a test mail goes
through with `SMTP_TLS_STRICT=1` (and `SMTP_TLS_SERVERNAME` if needed), keep
it on: without it, someone on the network path could read `SMTP_PASS`.

**Not changed:** the biometric device may still send its key as `?key=` in the
URL, because the vendor's settings offer that shape. Prefer the header forms
(`Authorization: Bearer`, `x-api-key`) where the device allows.

# 14. CRM access across companies

**Symptom:** someone given every CRM permission (for example the *Manager*
role) still sees no deals or leads. **Cause:** the level *All* means every
record **of that person's own company** (their company or second company).
Records imported from Bitrix24 belong to the company of their responsible
person, so a Nova employee sees none of Genie Lamp's or Jobways' records, and
nobody but a workspace admin sees imported records whose company is empty.

Run `supabase-crm-all-companies-migration.sql` (migration 12). It adds the
level **All companies** (every record of every company, and records with no
company) and a role **Full CRM access (every company)**. To give someone the
whole CRM: **Admin → CRM permissions →** the *Full CRM access (every
company)* column **→ +** → pick the person → **Save**. They also see every
pipeline and its stages. You can instead pick *All companies* for single
cells of any role. Nobody gains anything until you do.

Re-running migration 6 (`supabase-b24-migration.sql`) keeps the new level.
Re-run migration 12 after it anyway, because migration 1 resets the pipeline
policies.

# 15. Tasks, people pickers and wallpapers

- **New task** (`/tasks/?id=new`) follows Bitrix24's layout:
  - Task name; a description with attach, @mention and list tools; and a checklist.
  - *Task owner*, *Assignee* (**+** adds participants) and *Deadline* rows.
  - The *Task status summary is required* switch (migration 13). Completing
    such a task asks for the summary and posts it on the task.
  - Chips for files, checklists, project, participants, observers, tags,
    reminders, CRM items, parent task, time planning, priority and status.
  - The task chat panel.
  - Attached files are uploaded to Documents and linked to the task.
- **People pickers** everywhere in the CRM and work pages open a searchable
  pop-up with photo, Employee ID, name and company, as in Bitrix24.
- **Live wallpapers** (Themes): *Northern lights*, *Starfall*, *Ocean*,
  *City lights* and *Fireflies* animate behind the app. They run at up to
  30 frames a second, pause in hidden tabs, and stay still when the device
  asks for reduced motion. Light/dark and the wallpaper follow the person
  to every browser they sign in on.

