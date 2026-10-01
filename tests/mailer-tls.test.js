// lib/mailer.js — the SMTP certificate is verified (SEC-05), and only plain
// addresses are ever handed to the mail server (DEP-02's "validate recipient
// input"). A local implicit-TLS SMTP server with throwaway certificates
// (made with openssl for this run) stands in for the mail host: a valid
// certificate, one for another name, and a self-signed one. Nothing is sent
// anywhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');
const nodemailer = require('nodemailer');
const mailer = require('../lib/mailer');

function haveOpenssl() { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } }
const skip = haveOpenssl() ? false : 'openssl is not installed';

let dir, certs;
function makeCerts() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-smtp-tls-'));
  const f = n => path.join(dir, n);
  const ssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=WorkSuite Test CA');
  const leaf = (name, cn) => {
    fs.writeFileSync(f(name + '.ext'), `subjectAltName=DNS:${cn}\n`);
    ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=' + cn);
    ssl('x509', '-req', '-in', name + '.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', name + '.crt', '-days', '2', '-extfile', name + '.ext');
  };
  leaf('good', 'localhost');                 // what we connect to
  leaf('other', 'server42.host.example');    // a shared host's own name
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'self.key', '-out', 'self.crt', '-days', '2', '-subj', '/CN=localhost');
  const read = n => fs.readFileSync(f(n), 'utf8');
  return { ca: read('ca.crt'), good: [read('good.key'), read('good.crt')], other: [read('other.key'), read('other.crt')], self: [read('self.key'), read('self.crt')] };
}

/** A tiny SMTP server over implicit TLS that accepts any login and message. */
function smtpServer([key, cert]) {
  const received = [];
  const server = tls.createServer({ key, cert }, socket => {
    socket.write('220 localhost ESMTP test\r\n');
    let buf = '', data = false, message = '';
    socket.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') { data = false; received.push(message); message = ''; socket.write('250 queued\r\n'); }
          else message += line + '\n';
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') socket.write('250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        else if (cmd === 'AUTH') socket.write('235 ok\r\n');
        else if (cmd === 'MAIL' || cmd === 'RCPT') socket.write('250 ok\r\n');
        else if (cmd === 'DATA') { data = true; socket.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
    socket.on('error', () => {});
  });
  server.on('tlsClientError', () => {});
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, received })));
}

/** Send through lib/mailer's own transport settings, pointed at the local server. */
async function trySend(port, env) {
  const t = nodemailer.createTransport({ ...mailer.transportOptions('sender@nova.test', { SMTP_PASS: 'x', ...env }), port });
  try {
    await t.sendMail({ from: 'sender@nova.test', to: 'someone@nova.test', subject: 'TLS check', text: 'hello' });
    return { ok: true };
  } catch (e) { return { ok: false, code: e.code, message: e.message }; }
  finally { t.close(); }
}

test.before(() => { if (!skip) certs = makeCerts(); });
test.after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('certificates are verified by default: there is no setting that turns it off', () => {
  const opts = mailer.tlsOptions({ SMTP_HOST: 'mail.nova.test', SMTP_TLS_STRICT: '0', SMTP_TLS_INSECURE: '1' });
  assert.equal(opts.rejectUnauthorized, true);
  assert.equal(opts.servername, 'mail.nova.test');
  assert.equal(opts.minVersion, 'TLSv1.2');
  assert.equal(mailer.tlsOptions({ SMTP_HOST: 'mail.nova.test', SMTP_TLS_SERVERNAME: 'server42.host.example' }).servername, 'server42.host.example');
  assert.equal(mailer.transportOptions('a@b.co', { SMTP_HOST: 'h' }).tls.rejectUnauthorized, true);
});

test('SMTP_TLS_CA takes PEM text or base64 of it', { skip }, () => {
  assert.equal(mailer.tlsOptions({ SMTP_HOST: 'h', SMTP_TLS_CA: certs.ca }).ca.trim(), certs.ca.trim());
  assert.equal(mailer.tlsOptions({ SMTP_HOST: 'h', SMTP_TLS_CA: Buffer.from(certs.ca).toString('base64') }).ca.trim(), certs.ca.trim());
  assert.equal(mailer.tlsOptions({ SMTP_HOST: 'h', SMTP_TLS_CA: 'not a certificate' }).ca, undefined);
});

test('a valid certificate from a trusted authority: the mail goes', { skip }, async () => {
  const s = await smtpServer(certs.good);
  try {
    const r = await trySend(s.port, { SMTP_HOST: '127.0.0.1', SMTP_TLS_SERVERNAME: 'localhost', SMTP_TLS_CA: certs.ca });
    assert.deepEqual(r, { ok: true });
    assert.equal(s.received.length, 1);
  } finally { s.server.close(); }
});

test('a certificate for another name is refused, until SMTP_TLS_SERVERNAME names it', { skip }, async () => {
  const s = await smtpServer(certs.other);
  try {
    const refused = await trySend(s.port, { SMTP_HOST: '127.0.0.1', SMTP_TLS_SERVERNAME: 'localhost', SMTP_TLS_CA: certs.ca });
    assert.equal(refused.ok, false);
    assert.match(`${refused.code} ${refused.message}`, /ALTNAME|does not match|altnames/i);
    assert.equal(s.received.length, 0, 'no password or message went over the unverified connection');
    const fixed = await trySend(s.port, { SMTP_HOST: '127.0.0.1', SMTP_TLS_CA: certs.ca, SMTP_TLS_SERVERNAME: 'server42.host.example' });
    assert.deepEqual(fixed, { ok: true });
  } finally { s.server.close(); }
});

test('a self-signed (untrusted) certificate is refused', { skip }, async () => {
  const s = await smtpServer(certs.self);
  try {
    const r = await trySend(s.port, { SMTP_HOST: '127.0.0.1', SMTP_TLS_SERVERNAME: 'localhost', SMTP_TLS_CA: certs.ca });
    assert.equal(r.ok, false);
    assert.match(`${r.code} ${r.message}`, /self[- ]signed|SELF_SIGNED|unable to verify/i);
    assert.equal(s.received.length, 0);
  } finally { s.server.close(); }
});

test('only plain addresses reach the mail server', async () => {
  assert.deepEqual(mailer.recipients('A@Nova.test'), ['a@nova.test']);
  assert.deepEqual(mailer.recipients('a@nova.test, b@nova.test'), ['a@nova.test', 'b@nova.test']);
  assert.deepEqual(mailer.recipients(['a@nova.test']), ['a@nova.test']);
  for (const bad of ['', 'not-an-address', 'a@b', 'x@nova.test\r\nBcc: victim@evil.test', 'Name <a@nova.test>',
                     '"quoted"@nova.test', 'a@-bad-.test', Array(51).fill('a@nova.test')]) {
    assert.equal(mailer.recipients(bad), null, JSON.stringify(bad).slice(0, 60));
  }
  const prev = { ...process.env };
  Object.assign(process.env, { SMTP_HOST: 'localhost', SMTP_PASS: 'x', SMTP_USER_1: 'sender@nova.test' });
  try {
    const r = await mailer.sendMail({ company: 'Nova Sportsmart Private Limited', to: 'a@nova.test\nBcc: x@evil.test', subject: 's', text: 't' });
    assert.deepEqual([r.ok, r.reason], [false, 'bad_recipient']);
    const rt = await mailer.sendMail({ company: 'Nova Sportsmart Private Limited', to: 'a@nova.test', replyTo: 'a@b.co, c@d.co', subject: 's', text: 't' });
    assert.deepEqual([rt.ok, rt.reason], [false, 'bad_reply_to']);
  } finally { process.env = prev; }
});
