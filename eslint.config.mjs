// ESLint for a vanilla-JS app: plain browser scripts that share a few globals,
// CommonJS Vercel functions and helpers, and the <script> blocks inside the
// HTML pages (linted through the small processor below, no plugin needed).
//
//     npm run lint
//
// Errors are correctness problems (an undefined name, a duplicate key, code
// that can never run). Unused names and style findings are warnings.
import js from '@eslint/js';
import globals from 'globals';

// Globals one script publishes on window for the others. Listing them here is
// what lets no-undef catch a misspelt or missing one.
const SHARED = Object.fromEntries([
  'WSShell', 'WSGrid', 'WSFilter', 'WSCompanies', 'WSCalls', 'WSKanban', 'WSPush', 'WSWhiteboard', 'WSTheme',
  'WSCard', 'WSCreate', 'WSLiveWall', 'WSCrmPerms', 'WSDocEditors', 'WSCrm', 'WSAdminEmployees', 'WSAdminPeople',
  'WSAdminRouter', 'WSMfa', 'wsDialog', 'wsCmdK', 'wsIsOnlineByLastSeen', 'wsRenderOnlineDot',
  'WSAdminResetInactivityTimer', 'WSAdminLock', 'WSFavorites', 'WSNotifPrefs', 'WSCallMesh',
  // Admin console helpers defined by wsm-admin/index.html for admin/*.js.
  'escapeHtml', 'adminFetch', 'adminAuthenticated', 'empNameHtml',
  // Page helpers the home page defines for its own inline blocks.
  'showToast', 'showDialog', 'showOtpModal', 'switchAuthTab',
  // Libraries loaded from <script src>.
  'supabase', 'tailwind', 'Chart', 'QRCode', 'html2canvas', 'jspdf', 'pdfjsLib', 'XLSX', 'JSZip', 'Quill', 'marked', 'DOMPurify',
].map(n => [n, 'writable']));

/** Lints the classic <script> blocks of a page as one file, at their own line numbers. */
const inlineScripts = {
  preprocess(text) {
    const classic = [], modules = [];
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(text))) {
      const attrs = m[1];
      if (/\bsrc\s*=/i.test(attrs)) continue;
      const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1] || '';
      if (type && !/^(text\/javascript|module|application\/javascript)$/i.test(type)) continue;
      const before = text.slice(0, m.index + m[0].indexOf('>') + 1);
      (type.toLowerCase() === 'module' ? modules : classic).push({ line: before.split('\n').length - 1, code: m[2] });
    }
    const join = blocks => {
      let out = '', line = 0;
      for (const b of blocks) {
        out += '\n'.repeat(Math.max(0, b.line - line)) + b.code;
        line = b.line + b.code.split('\n').length - 1;
      }
      return out;
    };
    const files = [];
    if (classic.length) files.push({ text: join(classic), filename: 'inline.js' });
    modules.forEach((b, i) => files.push({ text: join([b]), filename: `module-${i}.mjs` }));
    return files;
  },
  postprocess: messages => messages.flat(),
  supportsAutofix: false,
};

export default [
  { ignores: ['**/node_modules/**', '.claude/**', '.vercel/**', '__cdn/**', 'exports/**', 'tests/ui-smoke/out/**',
    'desktop/dist/**', 'mobile/**', 'ui/vendor/**'] },
  { plugins: { ws: { processors: { inline: inlineScripts } } } },
  { files: ['**/*.html'], processor: 'ws/inline' },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.html/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: { ...globals.browser, ...SHARED } },
  },
  {
    files: ['**/*.mjs', '**/*.html/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser, ...SHARED } },
  },
  {
    files: ['api/**/*.js', 'lib/**/*.js', 'tests/**/*.js', 'scripts/**/*.js', 'desktop/**/*.js', 'company-config.js', 'tailwind.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  // Browser scripts the Node tests also load: they export through `module` when it exists.
  {
    files: ['company-config.js', 'ui/b24-filter.js', 'ui/b24-grid.js', 'ui/crm-logic.js', 'calendar/ics.js',
      'chat/chat-logic.js', 'call/mesh.js', 'documents/drive-logic.js'],
    languageOptions: { globals: { module: 'readonly', require: 'readonly' } },
  },
  // page.evaluate() callbacks in the browser harnesses run in the page.
  { files: ['tests/ui-smoke/**/*.js'], languageOptions: { globals: { ...globals.node, ...globals.browser, ...SHARED } } },
  { files: ['sw.js'], languageOptions: { globals: { ...globals.serviceworker } } },
  { files: ['eslint.config.mjs'], languageOptions: { sourceType: 'module', globals: { ...globals.node } } },
  {
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      // `catch {}` is this codebase's "best effort, ignore failures" idiom.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Pages define the shared helpers listed in SHARED; that is not a redeclaration.
      'no-redeclare': ['error', { builtinGlobals: false }],
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
      'preserve-caught-error': 'off',
    },
  },
];
