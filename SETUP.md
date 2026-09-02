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
  **Resend failed** button.
- Employees see their own punches at `/attendance/`.

### Notes

- The endpoint always answers `200` once a punch is stored — the vendor logs
  any non-2xx as an error, and a mail failure is ours to retry, not theirs.
- Replays are ignored: `(employee_code, log_datetime, direction, device_sn)`
  is unique, so re-exporting a date range inserts nothing and emails nothing.
- Naive timestamps from the device are read as **IST**.
