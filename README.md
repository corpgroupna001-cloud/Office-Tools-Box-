# Office-Tools-Box

WorkSuite — the internal employee platform: office management (attendance,
leave, shifts, payroll), CRM (contacts, leads, deals), collaboration
(messenger, boards, projects, tasks, documents, calendar), an employee
directory, invoices, plus the original tools (typing test, quizzes, email
signature, Friday check-ins) and the admin console.

Vanilla HTML/CSS/JS on Vercel, Supabase (Postgres + RLS, Auth, Realtime,
Storage). See `SETUP.md` for setup, migrations, permissions and deployment.

## Requirements

| For | Needs |
|---|---|
| Everything below | Node 24 (`.nvmrc`; Node 20 is the minimum Nodemailer 10 supports) and `npm ci` |
| `smoke:ui`, `test:calls` | Google Chrome or Chromium; set `CHROME_PATH` if it is not in the usual place |
| `desktop/` | The same Node; Electron is installed by `npm ci` in `desktop/` |
| `mobile/android/` | JDK 17 and the Android SDK (platform 34); Gradle comes with the wrapper |
| Production | Vercel (Hobby: at most 12 functions and 2 crons — `npm run check` enforces it) and a Supabase project with the migrations in `SETUP.md` |

Set the Vercel project's Node.js version to 22.x or 24.x (Project → Settings →
General); `package.json` deliberately does not pin `engines`, which would
override it.

## Run it locally

```
cp .env.example .env.local   # fill in a DEVELOPMENT Supabase project, never production
npm ci
npm run dev                  # http://localhost:3000
```

`npm run dev` (`scripts/dev-server.js`) serves the pages with clean URLs, the
`vercel.json` rewrites and redirects, and runs the `/api` functions the way
Vercel does, reloading them on every request. It needs no Vercel account.
Crons do not run; call `/api/wfh-remind` by hand if needed. `vercel dev`
works too for those already linked to the project.

## Checks

```
npm run verify      # static checks, lint, type check, unit + database tests
npm run smoke:ui    # every page in headless Chrome (CHROME_PATH=… to pick one)
npm run test:calls  # real WebRTC calls between browser peers
npm run test:all    # all of the above
```

The same commands run in GitHub Actions (`.github/workflows/ci.yml`) for every
pull request and for `main`, plus the desktop dependency audit and the Android
build and unit tests.

| Command | What it checks |
|---|---|
| `npm run build` | Writes the browser assets the pages load from the site: the third-party libraries in `ui/vendor/` (copied from `node_modules` at the exact versions in `package.json`) and `ui/tailwind.css` (Tailwind compiled ahead of time). The outputs are committed; Vercel needs no build step |
| `npm run check` | Local `<script>`/stylesheet references exist; external scripts are pinned to exact versions and no page compiles Tailwind at run time; `ui/vendor/` and `ui/tailwind.css` match what `npm run build` writes; `vercel.json` is valid and stays within the Hobby plan (12 functions, 2 crons); every migration runs in the test database and the CRM set is documented in `SETUP.md` |
| `npm run lint` | ESLint over every `.js` file and the `<script>` blocks inside the HTML pages. Errors are correctness problems (undefined names, duplicate keys, unreachable code); unused names are warnings |
| `npm run typecheck` | A scoped JSDoc type check: files that start with `// @ts-check` are checked by TypeScript (`tsconfig.json` for the server, `tsconfig.browser.json` for browser scripts). Nothing is compiled |
| `npm test` | Unit tests, and database tests that run every migration on an in-process Postgres (PGlite). They fail when PGlite or a listed migration file is missing; `WS_SKIP_DB_TESTS=1` skips them on purpose and says so |
| `npm run smoke:ui` | Every page at desktop and phone width in headless Chrome against fixture data, with every CDN refused and PostgREST's 1,000-row limit applied; plus keyboard-only dialogs, task completion, paging and partial-failure checks. Screenshots go to `tests/ui-smoke/out/` |
| `npm run test:calls` | Two browser peers in real WebRTC calls with fake camera and microphone |

## Desktop and Android shells

`desktop/` (an Electron window) and `mobile/android/` (a WebView app) wrap
the deployed site, so the workspace inside them is always the live one.
CI checks their dependencies and builds the Android app; installable builds
are made by hand:

```
cd desktop && npm ci && npm run dist           # .dmg / .exe (unsigned)
cd mobile/android && ./gradlew assembleDebug   # app-debug.apk
```

Both trust exactly one origin (scheme, host and port): only that site gets the
camera, microphone and location, and links leave the app only for https,
http, mailto and tel (`desktop/policy.js`, `WebPolicy.java`). The desktop
`package.json` has no `author`: electron-builder notes it; add the publisher's
name there before publishing a signed build.

Neither is signed, so a first run shows the usual "unidentified developer"
(macOS), SmartScreen (Windows) or "allow this source" (Android) prompt.
To point a build at another site, pass `--url=…` to the desktop app or
`-PworksuiteUrl=…` to Gradle.
