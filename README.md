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

## Installable apps (macOS, Windows, Android)

The apps are thin shells around the deployed site, so the workspace inside
them is always the live one — a change to WorkSuite needs no new build.

**To get them:** GitHub → **Actions** → **Apps** → *Run workflow*. When it
finishes, the files are under *Artifacts*:

| Platform | Files |
|---|---|
| macOS | `WorkSuite.dmg` and `.zip` (Apple silicon and Intel) |
| Windows | Installer (`.exe`) and a portable `.exe` (64-bit) |
| Android | `WorkSuite.apk` |

Pushing a tag (`git tag v1.0.0 && git push origin v1.0.0`) runs the same
build and attaches the files to a GitHub release instead.

This repository is public, so GitHub-hosted runners cost nothing.

**What people see on first run.** The builds are not signed, because a
signing certificate is a paid, per-year thing (Apple Developer, and a
Windows code-signing certificate):

- macOS: right-click the app → *Open* the first time, then *Open* again in
  the warning. After that it opens normally.
- Windows: SmartScreen says the publisher is unknown → *More info* → *Run
  anyway*.
- Android: the phone asks to allow installing from this source.

To sign later, add the certificates as repository secrets and pass them to
`electron-builder` and Gradle; nothing else about the build changes.

**Pointing a build at another site** (staging, say): *Run workflow* takes a
URL. Locally, `cd desktop && npm install && npm start -- --url=…`.

Sources: `desktop/` (Electron shell), `mobile/android/` (WebView app, which
also asks Android for the camera, microphone, location and file picker the
site uses), `.github/workflows/apps.yml` (the build).
