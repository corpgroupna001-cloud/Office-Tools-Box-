// ============================================================
// WorkSuite desktop — what the shell lets a page do.
//
// Pure decisions, no electron import, so tests/desktop-policy.test.js runs
// them in plain Node. main.js wires them to Electron's handlers.
//
// Trust is one exact origin (scheme + host + port): the site the app was
// built or started for. A page from anywhere else — including an iframe
// inside our own page — gets no permissions and never loads in the app.
// ============================================================
'use strict';

// What the workspace uses: calls (camera, microphone, picking a speaker),
// attendance selfies (location), notifications, copy buttons, full-screen
// video and documents, and mail/phone/web links handed to the system.
const PERMISSIONS = new Set([
  'media', 'speaker-selection', 'geolocation', 'notifications',
  'clipboard-sanitized-write', 'fullscreen', 'openExternal',
]);
const MEDIA_TYPES = new Set(['audio', 'video']);
// Links leaving the app go to the browser, mail or phone app only. Plain
// http is allowed because it only ever opens the default browser (chat
// messages carry such links); file:, javascript:, data: and app-specific
// schemes (smb:, ms-*, vscode:, …) can run things on the machine and never go.
const EXTERNAL_SCHEMES = new Set(['https:', 'http:', 'mailto:', 'tel:']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parse(url) {
  if (typeof url !== 'string' || !url) return null;
  try { return new URL(url); } catch (e) { return null; }
}

/**
 * The origin the app trusts, from the URL it was told to open: https
 * anywhere, plain http only on this machine (local testing). Else null.
 */
function appOrigin(url) {
  const u = parse(url);
  if (!u || u.username || u.password) return null;
  if (u.protocol === 'https:') return u.origin;
  if (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname)) return u.origin;
  return null;
}

/** Is `url` (a full URL or a bare origin) exactly `origin`? Opaque origins (about:, data:, sandboxed frames) never are. */
function sameOrigin(url, origin) {
  const u = parse(url);
  return !!(u && origin && u.origin !== 'null' && u.origin === origin);
}

/** May a link or window leave the app for this URL? */
function externalAllowed(url) {
  const u = parse(url);
  if (!u || !EXTERNAL_SCHEMES.has(u.protocol)) return false;
  if ((u.protocol === 'https:' || u.protocol === 'http:') && !u.hostname) return false;
  return true;
}

/** Where a top-level navigation goes: 'app' (stays), 'external' (system app), 'block'. */
function navigationTarget(origin, url) {
  if (sameOrigin(url, origin)) return 'app';
  return externalAllowed(url) ? 'external' : 'block';
}

/**
 * Where window.open(url) goes, opened from a window showing `openerUrl`.
 * Our own pages may open a blank window and fill it in (the call window
 * does: "Starting call…", then the call page). A window whose page is not
 * ours opens nothing inside the app.
 */
function windowOpenTarget(origin, url, openerUrl) {
  const fromUs = sameOrigin(openerUrl, origin);
  if (fromUs && (url === 'about:blank' || url === '')) return 'app';
  const where = navigationTarget(origin, url);
  return where === 'app' && !fromUs ? 'block' : where;
}

/**
 * May a page use `permission`?
 *   topUrl          the window's own page (undefined when there is no window,
 *                   e.g. a service worker check — then it is not checked)
 *   frameUrl        the requesting frame's last URL
 *   requestingOrigin / securityOrigin / embeddingOrigin  what Electron reports
 *   mediaTypes      for a media request: ['audio', 'video']
 *   externalURL     for an openExternal request
 * Every origin Electron reports must be ours, and at least one must be
 * reported: an iframe from another site is refused even inside our page.
 */
function permissionAllowed(origin, permission, req) {
  req = req || {};
  if (!origin || !PERMISSIONS.has(permission)) return false;
  if (req.topUrl !== undefined && !sameOrigin(req.topUrl, origin)) return false;
  const reported = [req.frameUrl, req.requestingOrigin, req.securityOrigin, req.embeddingOrigin]
    .filter(v => v !== undefined && v !== null && v !== '');
  if (!reported.length || !reported.every(v => sameOrigin(v, origin))) return false;
  if (permission === 'media' && req.mediaTypes !== undefined
      && !(Array.isArray(req.mediaTypes) && req.mediaTypes.every(t => MEDIA_TYPES.has(t)))) return false;
  if (permission === 'openExternal') return externalAllowed(req.externalURL);
  return true;
}

module.exports = {
  PERMISSIONS, EXTERNAL_SCHEMES,
  appOrigin, sameOrigin, externalAllowed, navigationTarget, windowOpenTarget, permissionAllowed,
};
