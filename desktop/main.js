// ============================================================
// WorkSuite desktop (macOS and Windows).
//
// A thin Electron shell around the deployed site: one window, the
// workspace inside it. Nothing is bundled offline, so the app never
// goes stale — it always shows what is live.
//
// The site it opens can be changed at build time (WORKSUITE_URL) or at
// run time (--url=…), which is how a staging build is made.
// ============================================================
const { app, BrowserWindow, shell, session } = require('electron');
const path = require('node:path');

const DEFAULT_URL = 'https://work-suite-mauve.vercel.app';
const argUrl = (process.argv.find(a => a.startsWith('--url=')) || '').slice(6);
const APP_URL = argUrl || process.env.WORKSUITE_URL || DEFAULT_URL;
const HOME = new URL(APP_URL);

/** Our own site — anything else belongs in the browser. */
function isOurs(url) {
  try { return new URL(url).host === HOME.host; } catch (e) { return false; }
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  win.loadURL(APP_URL);

  // Messenger calls need the camera and microphone; the site asks, we allow
  // it for our own pages only, and leave everything else to the system.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    const allowed = ['media', 'clipboard-sanitized-write', 'notifications', 'fullscreen'];
    callback(isOurs(contents.getURL()) && allowed.includes(permission));
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOurs(url)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isOurs(url)) { e.preventDefault(); shell.openExternal(url); }
  });
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
  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
