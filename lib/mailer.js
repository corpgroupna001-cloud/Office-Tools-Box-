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
// ============================================================

const nodemailer = require('nodemailer');

const COMPANY_TO_USER = {
  'Nova Sportsmart Private Limited': 'SMTP_USER_1',
  'CORPGROUP':                       'SMTP_USER_1',
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

function transportFor(user) {
  if (transporterCache[user]) return transporterCache[user];
  transporterCache[user] = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: 465,
    secure: true,
    auth: { user, pass: process.env.SMTP_PASS },
    // cPanel shared mail hosts often present a self-signed cert on the
    // hostname-specific SNI. We authenticate with a password anyway.
    tls: { rejectUnauthorized: false },
  });
  return transporterCache[user];
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
      from: `"${fromName}" <${sender.user}>`,
      to,
      subject,
      html,
      text,
      replyTo: replyTo || sender.user,
    });
    return { ok: true, from: sender.user, messageId: info.messageId };
  } catch (e) {
    return {
      ok: false,
      reason: 'smtp_send_failed',
      detail: String((e && (e.response || e.message)) || e).slice(0, 300),
    };
  }
}

module.exports = { sendMail, senderFor, COMPANY_TO_USER, COMING_SOON_COMPANIES };
