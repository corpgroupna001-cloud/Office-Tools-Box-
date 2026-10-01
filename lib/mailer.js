// ============================================================
// Shared outbound-mail helper.
//
// Same cPanel SMTP setup and per-company sender routing that /api/mail.js
// uses, exposed as a module so server-side code (the attendance webhook,
// admin resend) can send mail directly instead of making an HTTP round trip
// back to our own domain — which on Vercel would burn a second function
// invocation and half the 10s Hobby timeout.
//
// This file lives OUTSIDE /api on purpose: everything under /api becomes its
// own serverless function. Vercel bundles required relative files with the
// function that imports them.
//
// Env: SMTP_HOST, SMTP_PASS, SMTP_USER_1, SMTP_USER_2, SMTP_USER_3,
//      SMTP_FROM_NAME (optional)
//      SMTP_TLS_SERVERNAME (optional): the name on the server's certificate,
//        when it is not SMTP_HOST. cPanel hosts often present the server's own
//        name (say server123.hostingprovider.com) for mail.yourdomain.com.
//      SMTP_TLS_CA (optional): extra CA certificate(s), PEM text or base64 of it.
//
// The certificate is always verified (SEC-05). There is no switch to turn
// that off: without it anyone on the network path could read SMTP_PASS. If
// mail stops after an upgrade, the reply names the certificate problem; set
// SMTP_TLS_SERVERNAME to the name the host's certificate carries.
// ============================================================

const nodemailer = require('nodemailer');

const COMPANY_TO_USER = {
  'Nova Sportsmart Private Limited': 'SMTP_USER_1',
  'Protathlitis Sportsmart LLP':     'SMTP_USER_1',
  'Jobways Point LLP':               'SMTP_USER_2',
  'Genie Lamp Private Limited':      'SMTP_USER_3',
};

// No mailbox provisioned yet — callers should treat this as "not an error,
// just can't send", the same way /api/mail.js returns 503.
const COMING_SOON_COMPANIES = new Set([
  'Navyug Raise A Player Foundation',
  'Raise a Player',
]);

const transporterCache = {};

/** SMTP_TLS_CA as PEM: the PEM itself, or base64 of it (one line fits a Vercel variable). */
function caFrom(value) {
  const v = String(value || '').trim();
  if (!v) return undefined;
  if (v.includes('-----BEGIN')) return v.replace(/\\n/g, '\n');
  const pem = Buffer.from(v, 'base64').toString('utf8');
  return pem.includes('-----BEGIN') ? pem : undefined;
}

/** TLS settings for the SMTP connection: verified, TLS 1.2+, against the name the certificate carries. */
function tlsOptions(env = process.env) {
  const tls = { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: env.SMTP_TLS_SERVERNAME || env.SMTP_HOST };
  const ca = caFrom(env.SMTP_TLS_CA);
  if (ca) tls.ca = ca;
  return tls;
}

/** Everything nodemailer.createTransport gets for one sender mailbox. */
function transportOptions(user, env = process.env) {
  return {
    host: env.SMTP_HOST,
    port: 465,
    secure: true,
    auth: { user, pass: env.SMTP_PASS },
    tls: tlsOptions(env),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  };
}

function transportFor(user) {
  if (transporterCache[user]) return transporterCache[user];
  transporterCache[user] = nodemailer.createTransport(transportOptions(user));
  return transporterCache[user];
}

/* ---- What may be addressed: plain addresses only, checked here whoever the caller is ---- */
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const MAX_RECIPIENTS = 50;

/** One address or a list (array, or comma separated) → clean lowercase list, or null if any part is not a plain address. */
function recipients(value) {
  const list = (Array.isArray(value) ? value : String(value == null ? '' : value).split(','))
    .map(v => String(v == null ? '' : v).trim()).filter(Boolean);
  if (!list.length || list.length > MAX_RECIPIENTS) return null;
  for (const a of list) if (a.length > 254 || /[\r\n<>"]/.test(a) || !ADDRESS.test(a)) return null;
  return list.map(a => a.toLowerCase());
}

/** Why a certificate was refused, in words an administrator can act on. */
function tlsHint(e) {
  const code = String((e && e.code) || '');
  const text = String((e && (e.reason || e.message)) || '');
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || /altnames|hostname\/ip does not match/i.test(text)) {
    return ' The mail server\'s certificate is for another name: set SMTP_TLS_SERVERNAME to the name it carries.';
  }
  if (/SELF_SIGNED|UNABLE_TO_VERIFY|unable to get (local )?issuer|self[- ]signed/i.test(code + ' ' + text)) {
    return ' The mail server\'s certificate is not from a trusted authority: add its CA as SMTP_TLS_CA.';
  }
  if (/CERT_HAS_EXPIRED|expired/i.test(code + ' ' + text)) return ' The mail server\'s certificate has expired.';
  return '';
}

/**
 * Resolve which mailbox a company sends from.
 * @returns {{ ok: true, user: string } | { ok: false, reason: string, detail: string }}
 */
function senderFor(company) {
  if (!company) {
    return { ok: false, reason: 'no_company', detail: 'Employee has no company set on their profile.' };
  }
  if (COMING_SOON_COMPANIES.has(company)) {
    return { ok: false, reason: 'email_coming_soon', detail: `No mailbox configured yet for ${company}.` };
  }
  const envName = COMPANY_TO_USER[company];
  if (!envName) {
    return { ok: false, reason: 'unknown_company', detail: `Unknown company: ${company}` };
  }
  const user = process.env[envName];
  if (!user) {
    return { ok: false, reason: 'sender_not_configured', detail: `${envName} is not set in the Vercel environment.` };
  }
  return { ok: true, user };
}

/**
 * Send one email, picking the From mailbox from the employee's company.
 * Never throws — always resolves to a result object the caller can persist.
 *
 * @returns {Promise<{ ok: boolean, from?: string, messageId?: string, reason?: string, detail?: string }>}
 */
async function sendMail({ company, to, subject, html, text, replyTo }) {
  if (!to)                   return { ok: false, reason: 'no_recipient', detail: 'No destination address.' };
  const toList = recipients(to);
  if (!toList)               return { ok: false, reason: 'bad_recipient', detail: 'The destination is not a plain email address (or there are too many).' };
  const replyList = replyTo ? recipients(replyTo) : null;
  if (replyTo && (!replyList || replyList.length !== 1)) return { ok: false, reason: 'bad_reply_to', detail: 'Reply-To is not a single plain email address.' };
  if (!subject)              return { ok: false, reason: 'no_subject',   detail: 'No subject.' };
  if (!html && !text)        return { ok: false, reason: 'no_body',      detail: 'No body.' };
  if (!process.env.SMTP_HOST || !process.env.SMTP_PASS) {
    return { ok: false, reason: 'smtp_not_configured', detail: 'SMTP_HOST / SMTP_PASS missing.' };
  }

  const sender = senderFor(company);
  if (!sender.ok) return { ok: false, reason: sender.reason, detail: sender.detail };

  const fromName = process.env.SMTP_FROM_NAME || 'WorkSuite';
  try {
    const info = await transportFor(sender.user).sendMail({
      from: { name: fromName, address: sender.user },
      to: toList,
      subject: String(subject).replace(/[\r\n]+/g, ' ').slice(0, 300),
      html,
      text,
      replyTo: replyList ? replyList[0] : sender.user,
    });
    return { ok: true, from: sender.user, messageId: info.messageId };
  } catch (e) {
    return {
      ok: false,
      reason: 'smtp_send_failed',
      detail: (String((e && (e.response || e.message)) || e) + tlsHint(e)).slice(0, 400),
    };
  }
}

module.exports = { sendMail, senderFor, recipients, tlsOptions, transportOptions, COMPANY_TO_USER, COMING_SOON_COMPANIES };
