// ============================================================
// WorkSuite — outbound email over cPanel SMTP (nodemailer, port 465 / SSL).
//
// Sender routing (per company): one SMTP host + one password, but three
// different "From" mailboxes depending on which corporate entity the
// employee belongs to.
//
//   Nova Sportsmart Private Limited  \
//   CORPGROUP                          }  →  SMTP_USER_1
//   Protathlitis Sportsmart LLP      /
//   Jobways Point LLP                    →  SMTP_USER_2
//   Genie Lamp Private Limited           →  SMTP_USER_3
//   Raise a Player                       →  (503, email not yet configured)
//
// Required env vars (Vercel → Project Settings → Environment Variables):
//   SMTP_HOST            e.g. mail.yourdomain.com
//   SMTP_PASS            shared password for all three mailboxes
//   SMTP_USER_1          sender for Nova / CORPGROUP / Protathlitis
//   SMTP_USER_2          sender for Jobways Point
//   SMTP_USER_3          sender for Genie Lamp
//   SMTP_FROM_NAME       optional display name, defaults to "WorkSuite"
//   MAIL_API_KEY         shared secret; every internal caller must send
//                        it as x-worksuite-mail-key so random clients on
//                        the web can't spam through this endpoint.
// ============================================================

const nodemailer = require('nodemailer');

const COMPANY_TO_USER = {
  'Nova Sportsmart Private Limited': 'SMTP_USER_1',
  'CORPGROUP':                       'SMTP_USER_1',
  'Protathlitis Sportsmart LLP':     'SMTP_USER_1',
  'Jobways Point LLP':               'SMTP_USER_2',
  'Genie Lamp Private Limited':      'SMTP_USER_3',
};
// "Navyug Raise A Player Foundation" intentionally absent — handled as 503 below.
const COMING_SOON_COMPANIES = new Set(['Navyug Raise A Player Foundation', 'Raise a Player']);

const transporterCache = {}; // reuse one nodemailer transport per sender

function transportFor(user) {
  if (transporterCache[user]) return transporterCache[user];
  transporterCache[user] = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: 465,
    secure: true, // implicit SSL on 465
    auth: { user, pass: process.env.SMTP_PASS },
    // cPanel shared mail hosts sometimes use self-signed certs on the
    // hostname-specific SNI — accept them since we're authenticating
    // with a password anyway.
    tls: { rejectUnauthorized: false },
  });
  return transporterCache[user];
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-worksuite-mail-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // Shared-secret gate so this endpoint isn't an open relay for the internet.
  const key = String(req.headers['x-worksuite-mail-key'] || '');
  if (!process.env.MAIL_API_KEY) {
    return res.status(500).json({ error: 'MAIL_API_KEY not configured on server.' });
  }
  if (key !== process.env.MAIL_API_KEY) {
    return res.status(401).json({ error: 'Invalid mail key' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { company, to, subject, html, text, replyTo } = body;

  if (!to || !subject || !(html || text)) {
    return res.status(400).json({ error: 'to, subject, and one of html/text are required' });
  }
  if (!company) {
    return res.status(400).json({ error: 'company is required (used to pick the sender mailbox)' });
  }

  // Navyug Raise A Player Foundation doesn't have a mailbox yet — surface a
  // specific status so the client can show a "coming soon" toast rather than
  // a generic error.
  if (COMING_SOON_COMPANIES.has(company)) {
    return res.status(503).json({ error: 'email_coming_soon', message: 'Email sending is coming soon for this company.' });
  }

  const envName = COMPANY_TO_USER[company];
  if (!envName) {
    return res.status(400).json({ error: 'Unknown company: ' + company });
  }
  const senderUser = process.env[envName];
  if (!senderUser) {
    return res.status(500).json({ error: `${envName} not configured on server — set it in Vercel env vars.` });
  }
  if (!process.env.SMTP_HOST || !process.env.SMTP_PASS) {
    return res.status(500).json({ error: 'SMTP_HOST / SMTP_PASS not configured on server.' });
  }

  const fromName = process.env.SMTP_FROM_NAME || 'WorkSuite';
  try {
    const info = await transportFor(senderUser).sendMail({
      from: `"${fromName}" <${senderUser}>`,
      to,
      subject,
      html,
      text,
      replyTo: replyTo || senderUser,
    });
    return res.status(200).json({ success: true, messageId: info.messageId, from: senderUser });
  } catch (e) {
    // Surface the SMTP error verbatim so we can diagnose auth / connection issues quickly.
    console.error('[mail] send failed', e);
    return res.status(502).json({
      error: 'smtp_send_failed',
      detail: e && (e.response || e.message) || String(e),
      code: e && e.code,
    });
  }
};
