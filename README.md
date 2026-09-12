# Office-Tools-Box

WorkSuite — the internal employee platform: office management (attendance,
leave, shifts, payroll), CRM (contacts, leads, deals), collaboration
(messenger, boards, projects, tasks, documents, calendar), an employee
directory, invoices, plus the original tools (typing test, quizzes, email
signature, Friday check-ins) and the admin console.

Vanilla HTML/CSS/JS on Vercel, Supabase (Postgres + RLS, Auth, Realtime,
Storage). See `SETUP.md` for setup, migrations, permissions and deployment.

```
npm test
```

## Desktop and Android shells

`desktop/` (an Electron window) and `mobile/android/` (a WebView app) wrap
the deployed site, so the workspace inside them is always the live one.
There is no build workflow for them — build one by hand when an installable
app is wanted:

```
cd desktop && npm install && npm run dist      # .dmg / .exe
cd mobile/android && gradle assembleDebug      # app-debug.apk
```

Neither is signed, so a first run shows the usual "unidentified developer"
(macOS), SmartScreen (Windows) or "allow this source" (Android) prompt.
To point a build at another site, pass `--url=…` to the desktop app or
`-PworksuiteUrl=…` to Gradle.
