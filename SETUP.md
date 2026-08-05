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
| `https://work-suite-mauve.vercel.app/Network.ADMIN` | Admin dashboard — password required |

---

## Testing

1. Visit `/typingtest/` → sign up with your email + password
2. Complete a test → you should see the "Download Result" button and a saved record in Supabase (`test_results` table)
3. Visit `/Network.ADMIN` → enter your `ADMIN_PASSWORD` → you should see your test result
