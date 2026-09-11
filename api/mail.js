const { sendMail } = require('../lib/mailer');
const { recordMail } = require('../lib/mail-audit');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-worksuite-mail-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // A signed-in manager emailing an invoice. Authenticated by their own
  // Supabase token; the recipient and content are built server-side from the
  // invoice row (lib/invoice-mail.js), so this is not a relay either. It lives
  // here rather than in a new file because the deployment is at the Vercel
  // Hobby 12-function limit.
  const authz = String(req.headers.authorization || '');
  if (/^Bearer\s+/i.test(authz)) {
    let parsed = null;
    try { parsed = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch { parsed = null; }
    if (parsed && typeof parsed === 'object' && parsed.action === 'invoice') {
      const SUPABASE_URL = process.env.SUPABASE_URL, SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Supabase server config missing' });
      try {
        const out = await require('../lib/invoice-mail').emailInvoice(parsed, {
          url: SUPABASE_URL, key: SERVICE_KEY, token: authz.replace(/^Bearer\s+/i, ''), sendMail, recordMail,
        });
        return res.status(200).json(out);
      } catch (e) {
        return res.status(e.status || 502).json({ error: e.message || 'Could not email the invoice' });
      }
    }
    // A signed-in manager inviting people to sign up (Employees → Invite).
    // The text, the link and the sender are built server-side in
    // lib/invite-mail.js; the request only names the company and addresses.
    if (parsed && typeof parsed === 'object' && parsed.action === 'invite') {
      const SUPABASE_URL = process.env.SUPABASE_URL, SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Supabase server config missing' });
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'http' ? 'http' : 'https';
      const origin = process.env.APP_URL ? String(process.env.APP_URL).replace(/\/+$/, '') : `${proto}://${host}`;
      try {
        const out = await require('../lib/invite-mail').emailInvite(parsed, {
          url: SUPABASE_URL, key: SERVICE_KEY, token: authz.replace(/^Bearer\s+/i, ''), origin, sendMail, recordMail,
        });
        return res.status(200).json(out);
      } catch (e) {
        return res.status(e.status || 502).json({ error: e.message || 'Could not send the invitations' });
      }
    }
  }

  // Shared-secret gate so this endpoint isn't an open relay for the internet.
  const key = String(req.headers['x-worksuite-mail-key'] || '');
  if (!process.env.MAIL_API_KEY) {
    return res.status(500).json({ error: 'MAIL_API_KEY not configured on server.' });
  }
  if (key !== process.env.MAIL_API_KEY) {
    return res.status(401).json({ error: 'Invalid mail key' });
  }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  const { company, to, subject, html, text, replyTo } = body;

  if (!to || !subject || !(html || text)) {
    return res.status(400).json({ error: 'to, subject, and one of html/text are required' });
  }
  if (!company) {
    return res.status(400).json({ error: 'company is required (used to pick the sender mailbox)' });
  }

  const result = await sendMail({ company, to, subject, html, text, replyTo });
  const auditRecorded = await recordMail({ company, to, category: body.category }, result);
  if (result.ok) return res.status(200).json({ success: true, messageId: result.messageId, from: result.from, audit_recorded: auditRecorded });
  const code = result.reason === 'email_coming_soon' ? 503 : result.reason === 'unknown_company' ? 400 : 502;
  return res.status(code).json({ error: result.reason, detail: result.detail, audit_recorded: auditRecorded });
};
