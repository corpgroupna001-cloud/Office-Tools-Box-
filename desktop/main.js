// ============================================================
// WorkSuite desktop (macOS and Windows).
//
// A thin Electron shell around the deployed site: one window, the
// workspace inside it. Nothing is bundled offline, so the app never
// goes stale — it always shows what is live.
//
// The site it opens can be changed at build time (WORKSUITE_URL) or at
// run time (--url=…), which is how a staging build is made. Only https
// (or http on this machine) is accepted; anything else opens the live site.
//
// What pages may do — permissions, links, new windows — is decided in
// policy.js against that one exact origin (scheme, host and port).
// ============================================================
const { app, BrowserWindow, shell, session } = require('electron');
const policy = require('./policy');

const DEFAULT_URL = 'https://work-suite-mauve.vercel.app';
const argUrl = (process.argv.find(a => a.startsWith('--url=')) || '').slice(6);
const WANTED_URL = argUrl || process.env.WORKSUITE_URL || DEFAULT_URL;
const APP_URL = policy.appOrigin(WANTED_URL) ? WANTED_URL : DEFAULT_URL;
if (APP_URL !== WANTED_URL) console.error(`WorkSuite: ignoring ${WANTED_URL} (https only, or http on localhost); opening ${DEFAULT_URL}`);
const ORIGIN = policy.appOrigin(APP_URL);

// Every window, the call windows included, runs with the same locked-down settings.
const WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: true,
};

function openOutside(url) {
  if (policy.externalAllowed(url)) shell.openExternal(url).catch(() => {});
}

/**
 * The rules every page in the app gets — the main window and any window it
 * opens: stay on our site, hand allowed links to the system, nothing else.
 */
function guard(contents) {
  contents.on('will-navigate', (e, legacyUrl) => {
    const url = e.url || legacyUrl;
    const where = policy.navigationTarget(ORIGIN, url);
    if (where === 'app') return;
    e.preventDefault();
    if (where === 'external') openOutside(url);
  });
  // A server redirect off our site is treated like a link off it.
  contents.on('will-redirect', (e, legacyUrl, isInPlace, legacyMainFrame) => {
    const url = e.url || legacyUrl;
    const mainFrame = e.isMainFrame !== undefined ? e.isMainFrame : legacyMainFrame;
    if (!mainFrame) return;
    const where = policy.navigationTarget(ORIGIN, url);
    if (where === 'app') return;
    e.preventDefault();
    if (where === 'external') openOutside(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    const where = policy.windowOpenTarget(ORIGIN, url, contents.getURL());
    if (where === 'app') return { action: 'allow', overrideBrowserWindowOptions: { backgroundColor: '#0b1017', webPreferences: WEB_PREFERENCES } };
    if (where === 'external') openOutside(url);
    return { action: 'deny' };
  });
  // The workspace never embeds <webview>; one appearing is not ours.
  contents.on('will-attach-webview', e => e.preventDefault());
}

/**
 * Calls need the camera and microphone, attendance needs location; the site
 * asks, and only our own pages — the requesting frame as well as the window
 * — get an answer other than no.
 */
function setPermissions(ses) {
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const d = details || {};
    callback(policy.permissionAllowed(ORIGIN, permission, {
      topUrl: contents ? contents.getURL() : undefined,
      frameUrl: d.requestingUrl,
      securityOrigin: d.securityOrigin,
      mediaTypes: d.mediaTypes,
      externalURL: d.externalURL,
    }));
  });
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const d = details || {};
    return policy.permissionAllowed(ORIGIN, permission, {
      topUrl: contents ? contents.getURL() : undefined,
      requestingOrigin,
      frameUrl: d.requestingUrl,
      securityOrigin: d.securityOrigin,
      embeddingOrigin: d.embeddingOrigin,
    });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 560,
    title: 'WorkSuite',
    backgroundColor: '#0b3f73',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: WEB_PREFERENCES,
  });

  win.loadURL(APP_URL);

  // A blank window after a dropped connection is worse than a retry.
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) setTimeout(() => win.loadURL(APP_URL), 2500);
  });

  // Unread messages and notifications on the dock / taskbar icon. The counts
  // come from the badges the workspace already shows in its header.
  const READ_BADGES = `(() => {
    let n = 0;
    document.querySelectorAll('#ws-bell-count, [data-ws-badge="unread"]').forEach(el => {
      if (el.hidden || el.offsetParent === null) return;
      const v = parseInt((el.textContent || '').replace(/[^0-9]/g, ''), 10);
      if (isFinite(v)) n += v;
    });
    return n;
  })()`;
  const badgeTimer = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(badgeTimer);
    win.webContents.executeJavaScript(READ_BADGES)
      .then(n => { if (app.setBadgeCount) app.setBadgeCount(Math.max(0, Number(n) || 0)); })
      .catch(() => {});                       // page still loading, or navigated away
  }, 15000);
  win.on('closed', () => clearInterval(badgeTimer));

  return win;
}

// One workspace window, however many times the app is opened.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.on('web-contents-created', (e, contents) => guard(contents));
  app.whenReady().then(() => {
    setPermissions(session.defaultSession);
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
