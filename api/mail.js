const { sendMail } = require('../lib/mailer');
const { recordMail } = require('../lib/mail-audit');

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
