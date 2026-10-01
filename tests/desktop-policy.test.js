// Desktop shell: which pages get permissions, which links leave the app, and
// which windows it opens (desktop/policy.js). Plain Node, no Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../desktop/policy');

const ORIGIN = 'https://work-suite-mauve.vercel.app';
const PAGE = ORIGIN + '/call/?id=1';
/** A request from our own page, as Electron reports it for a top-level frame. */
const ours = extra => ({ topUrl: PAGE, frameUrl: PAGE, ...extra });

test('the trusted origin is exact: https anywhere, http only on this machine', () => {
  assert.equal(P.appOrigin('https://work-suite-mauve.vercel.app/some/page?x=1'), ORIGIN);
  assert.equal(P.appOrigin('https://Work-Suite-Mauve.vercel.app:443'), ORIGIN);
  assert.equal(P.appOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(P.appOrigin('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  for (const bad of ['http://work-suite-mauve.vercel.app', 'file:///etc/passwd', 'javascript:alert(1)',
                     'ftp://x.example', 'not a url', '', null, undefined, 'https://user:pw@work-suite-mauve.vercel.app'])
    assert.equal(P.appOrigin(bad), null, String(bad));
});

test('same origin means the same scheme, host and port — lookalikes are not ours', () => {
  assert.ok(P.sameOrigin(PAGE, ORIGIN));
  assert.ok(P.sameOrigin(ORIGIN, ORIGIN));
  assert.ok(P.sameOrigin('https://work-suite-mauve.vercel.app:443/x', ORIGIN));
  for (const other of [
    'http://work-suite-mauve.vercel.app/',               // scheme
    'https://work-suite-mauve.vercel.app:8443/',         // port
    'https://evil.example/',                             // host
    'https://work-suite-mauve.vercel.app.evil.example/', // suffix lookalike
    'https://evilwork-suite-mauve.vercel.app/',          // prefix lookalike
    'https://work-suite-mauve.vercel.app@evil.example/', // userinfo trick: host is evil.example
    'https://sub.work-suite-mauve.vercel.app/',          // a subdomain is another origin
    'about:blank', 'data:text/html,hi', 'null', '', undefined,
  ]) assert.equal(P.sameOrigin(other, ORIGIN), false, String(other));
});

test('our pages get the permissions the workspace uses', () => {
  for (const perm of ['media', 'speaker-selection', 'geolocation', 'notifications', 'clipboard-sanitized-write', 'fullscreen'])
    assert.equal(P.permissionAllowed(ORIGIN, perm, ours()), true, perm);
  assert.equal(P.permissionAllowed(ORIGIN, 'media', ours({ mediaTypes: ['audio', 'video'], securityOrigin: ORIGIN })), true);
  // A permission check made with the frame's origin rather than its URL.
  assert.equal(P.permissionAllowed(ORIGIN, 'media', { topUrl: PAGE, requestingOrigin: ORIGIN }), true);
  // A service worker check has no window; its origin still has to be ours.
  assert.equal(P.permissionAllowed(ORIGIN, 'notifications', { requestingOrigin: ORIGIN }), true);
  assert.equal(P.permissionAllowed(ORIGIN, 'notifications', { requestingOrigin: 'https://evil.example' }), false);
});

test('permissions the workspace does not use are refused, even for our own pages', () => {
  for (const perm of ['clipboard-read', 'display-capture', 'hid', 'usb', 'serial', 'midiSysex', 'pointerLock',
                      'keyboardLock', 'idle-detection', 'window-management', 'fileSystem', 'unknown', '', undefined])
    assert.equal(P.permissionAllowed(ORIGIN, perm, ours()), false, String(perm));
  // Media requests are camera and microphone only.
  assert.equal(P.permissionAllowed(ORIGIN, 'media', ours({ mediaTypes: ['audio', 'screen'] })), false);
  assert.equal(P.permissionAllowed(ORIGIN, 'media', ours({ mediaTypes: 'video' })), false);
});

test('pages from anywhere else get nothing: wrong scheme, port, host or lookalike', () => {
  for (const url of ['http://work-suite-mauve.vercel.app/call/', 'https://work-suite-mauve.vercel.app:8443/call/',
                     'https://evil.example/', 'https://work-suite-mauve.vercel.app.evil.example/'])
    assert.equal(P.permissionAllowed(ORIGIN, 'media', { topUrl: url, frameUrl: url }), false, url);
  // No origin reported at all is a no, never a yes.
  assert.equal(P.permissionAllowed(ORIGIN, 'media', { topUrl: PAGE }), false);
  assert.equal(P.permissionAllowed(ORIGIN, 'media', { topUrl: PAGE, frameUrl: '' }), false);
  assert.equal(P.permissionAllowed(ORIGIN, 'media', {}), false);
  assert.equal(P.permissionAllowed(null, 'media', ours()), false);
  // A window that is still blank, or showing about:blank, is not ours yet.
  assert.equal(P.permissionAllowed(ORIGIN, 'media', { topUrl: '', frameUrl: PAGE }), false);
  assert.equal(P.permissionAllowed(ORIGIN, 'media', { topUrl: 'about:blank', frameUrl: 'about:blank' }), false);
});

test('a cross-origin iframe inside our page is refused, whatever the window shows', () => {
  const frame = 'https://abc.supabase.co/storage/v1/object/sign/file.html';
  assert.equal(P.permissionAllowed(ORIGIN, 'media', { topUrl: PAGE, frameUrl: frame }), false);
  assert.equal(P.permissionAllowed(ORIGIN, 'geolocation', { topUrl: PAGE, frameUrl: frame, securityOrigin: ORIGIN }), false);
  // Electron reports the embedding origin for cross-origin subframe checks.
  assert.equal(P.permissionAllowed(ORIGIN, 'media', { topUrl: PAGE, requestingOrigin: 'https://abc.supabase.co', embeddingOrigin: ORIGIN }), false);
  assert.equal(P.permissionAllowed(ORIGIN, 'media', { topUrl: PAGE, requestingOrigin: ORIGIN, embeddingOrigin: 'https://evil.example' }), false);
  // A sandboxed (opaque-origin) frame of our own page is not trusted either.
  assert.equal(P.permissionAllowed(ORIGIN, 'media', { topUrl: PAGE, frameUrl: PAGE, securityOrigin: 'null' }), false);
  // A same-origin iframe of our own page (the slide-over panels) is ours.
  assert.equal(P.permissionAllowed(ORIGIN, 'clipboard-sanitized-write', { topUrl: PAGE, frameUrl: ORIGIN + '/tasks/?id=7' }), true);
});

test('links leave the app only for the browser, mail and phone apps', () => {
  for (const url of ['https://example.com/a', 'http://example.com/', 'mailto:someone@example.com', 'tel:+911234567890'])
    assert.equal(P.externalAllowed(url), true, url);
  for (const url of ['file:///Applications/Calculator.app', 'javascript:alert(1)', 'data:text/html,<b>x</b>',
                     'smb://host/share', 'ms-msdt:/id', 'vscode://file/x', 'about:blank', 'blob:https://x/1',
                     'https://', 'not a url', '', null, undefined])
    assert.equal(P.externalAllowed(url), false, String(url));
  assert.equal(P.permissionAllowed(ORIGIN, 'openExternal', ours({ externalURL: 'mailto:a@b.co' })), true);
  assert.equal(P.permissionAllowed(ORIGIN, 'openExternal', ours({ externalURL: 'smb://host/share' })), false);
  assert.equal(P.permissionAllowed(ORIGIN, 'openExternal', { topUrl: PAGE, frameUrl: 'https://evil.example/', externalURL: 'mailto:a@b.co' }), false);
});

test('navigation stays on our site; everything else goes out or nowhere', () => {
  assert.equal(P.navigationTarget(ORIGIN, ORIGIN + '/tasks/'), 'app');
  assert.equal(P.navigationTarget(ORIGIN, 'https://example.com/'), 'external');
  assert.equal(P.navigationTarget(ORIGIN, 'http://work-suite-mauve.vercel.app/'), 'external');   // our host over http is not the app
  assert.equal(P.navigationTarget(ORIGIN, 'mailto:a@b.co'), 'external');
  assert.equal(P.navigationTarget(ORIGIN, 'file:///etc/hosts'), 'block');
  assert.equal(P.navigationTarget(ORIGIN, 'javascript:alert(1)'), 'block');
  assert.equal(P.navigationTarget(ORIGIN, 'zoommtg://join'), 'block');
});

test('new windows: our pages may open a blank call window; others open nothing in the app', () => {
  assert.equal(P.windowOpenTarget(ORIGIN, 'about:blank', ORIGIN + '/chat/'), 'app');
  assert.equal(P.windowOpenTarget(ORIGIN, ORIGIN + '/call/?id=1', ORIGIN + '/chat/'), 'app');
  assert.equal(P.windowOpenTarget(ORIGIN, 'https://abc.supabase.co/file.pdf', ORIGIN + '/documents/'), 'external');
  assert.equal(P.windowOpenTarget(ORIGIN, 'file:///etc/hosts', ORIGIN + '/chat/'), 'block');
  // A window that is not showing our site cannot open app windows, blank or not.
  assert.equal(P.windowOpenTarget(ORIGIN, 'about:blank', 'https://evil.example/'), 'block');
  assert.equal(P.windowOpenTarget(ORIGIN, ORIGIN + '/call/', 'about:blank'), 'block');
  assert.equal(P.windowOpenTarget(ORIGIN, 'https://example.com/', 'https://evil.example/'), 'external');
});

test('main.js applies the policy to every window and ships it', () => {
  const dir = path.join(__dirname, '..', 'desktop');
  const main = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  assert.match(main, /require\('\.\/policy'\)/);
  assert.match(main, /app\.on\('web-contents-created'/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /setPermissionCheckHandler/);
  assert.match(main, /will-attach-webview/);
  assert.doesNotMatch(main, /shell\.openExternal\(url\)\s*;/, 'every openExternal goes through the scheme check');
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('policy.js'), 'packaged app includes policy.js');
  const lockIgnored = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n').includes('package-lock.json');
  assert.equal(lockIgnored, false, 'the desktop lockfile is committed');
});
