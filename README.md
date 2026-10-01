# Office-Tools-Box

WorkSuite — the internal employee platform: office management (attendance,
leave, shifts, payroll), CRM (contacts, leads, deals), collaboration
(messenger, boards, projects, tasks, documents, calendar), an employee
directory, invoices, plus the original tools (typing test, quizzes, email
signature, Friday check-ins) and the admin console.

Vanilla HTML/CSS/JS on Vercel, Supabase (Postgres + RLS, Auth, Realtime,
Storage). See `SETUP.md` for setup, migrations, permissions and deployment.

```
npm ci              # Node 24 (see .nvmrc)
npm run verify      # static checks, lint, type check, unit + database tests
npm run smoke:ui    # every page in headless Chrome (CHROME_PATH=… to pick one)
npm run test:calls  # real WebRTC calls between browser peers
```

| Command | What it checks |
|---|---|
| `npm run build` | Writes the browser assets the pages load from the site: the third-party libraries in `ui/vendor/` (copied from `node_modules` at the exact versions in `package.json`) and `ui/tailwind.css` (Tailwind compiled ahead of time). The outputs are committed; Vercel needs no build step |
| `npm run check` | Local `<script>`/stylesheet references exist; external scripts are pinned to exact versions and no page compiles Tailwind at run time; `ui/vendor/` and `ui/tailwind.css` match what `npm run build` writes; `vercel.json` is valid and stays within the Hobby plan (12 functions, 2 crons); every migration runs in the test database and the CRM set is documented in `SETUP.md` |
| `npm run lint` | ESLint over every `.js` file and the `<script>` blocks inside the HTML pages. Errors are correctness problems (undefined names, duplicate keys, unreachable code); unused names are warnings |
| `npm run typecheck` | A scoped JSDoc type check: files that start with `// @ts-check` are checked by TypeScript (`tsconfig.json` for the server, `tsconfig.browser.json` for browser scripts). Nothing is compiled |
| `npm test` | Unit tests, and database tests that run every migration on an in-process Postgres (PGlite) |

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
