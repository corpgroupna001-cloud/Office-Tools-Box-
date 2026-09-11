// Web Push and call plumbing — notifications that arrive even when the
// WorkSuite tab (or the whole browser window) is closed, and the relay
// servers a call needs. One function serves both: the Hobby plan's twelve
// functions are all in use.
//
//   GET  /api/push                     public VAPID key for pushManager.subscribe()
//   GET  /api/ice  (→ /api/push?fn=ice) STUN/TURN servers for a call (signed-in only)
//   POST /api/push { action, ... }     signed-in only:
//        subscribe / unsubscribe       this browser's push subscription
//        message   { message_id }      a chat message → its recipients' devices
//        call      { call_id }         ring the callees' devices
//        call-end  { call_id }         turn "Incoming call" into "Missed call", or clear it
//        notify    { to, title, body, url, tag }   free-form push (CRM mentions and tasks)
//
// For message, call and call-end the server reads the rows itself with the
// service key and decides who hears what (lib/comms-push.js), so a browser
// cannot put words in a colleague's notifications or ring people for a call
// it did not start.
//
// Env vars (Vercel):
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY  (web-push VAPID keypair)
//   VAPID_SUBJECT                          (mailto: contact, e.g. mailto:network.admin@sportsmart.com)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//   optional TURN provider for calls       (see lib/ice-servers.js and SETUP.md, "Calls")
//
// Auth model: every POST and /api/ice must carry the CALLER'S OWN Supabase
// access token (Authorization: Bearer <jwt>), verified against Supabase Auth.
'use strict';
const webpush = require('web-push');
const { iceServersFor } = require('../lib/ice-servers');
const P = require('../lib/comms-push');

function queryParam(req, name) {
  if (req.query && req.query[name] != null) return String(req.query[name]);
  try { return new URL(req.url || '/', 'http://localhost').searchParams.get(name) || ''; } catch { return ''; }
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) { try { return JSON.parse(req.body); } catch { return null; } }
  return {};
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
  const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:network.admin@sportsmart.com';
  const isIce = queryParam(req, 'fn') === 'ice';

  // Public key for the browser's pushManager.subscribe()
  if (req.method === 'GET' && !isIce) {
    if (!VAPID_PUBLIC_KEY) return res.status(500).json({ error: 'VAPID keys not configured' });
    return res.status(200).json({ publicKey: VAPID_PUBLIC_KEY });
  }
  if (req.method !== 'POST' && !(isIce && req.method === 'GET')) return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase server config missing' });
  }

  const body = isIce ? {} : readBody(req);
  if (!body) return res.status(400).json({ error: 'Invalid JSON' });
  const action = isIce ? 'ice' : String(body.action || '');

  // ---- Verify the caller's Supabase session token ----
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization token' });
  let caller = null;
  try {
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
    });
    if (!ur.ok) return res.status(401).json({ error: 'Invalid session' });
    caller = await ur.json();
  } catch {
    return res.status(401).json({ error: 'Auth check failed' });
  }
  if (!caller?.id) return res.status(401).json({ error: 'Invalid session' });

  if (action === 'ice') {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json(await iceServersFor(caller.id));
  }

  // A call window that is closing sends one keepalive request that hangs up
  // and clears the ringing notifications. The hang-up runs first, as the
  // caller themselves (their own token, so the database's own rules apply),
  // so the call is already settled when we decide what each phone shows.
  if (action === 'call-end' && body.leave && P.isUuid(String(body.call_id || ''))) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/ws_call_action`, {
        method: 'POST',
        headers: { apikey: process.env.SUPABASE_ANON_KEY || SERVICE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_call: String(body.call_id), p_action: 'leave', p_device: body.device ? String(body.device).slice(0, 100) : null }),
      });
    } catch { /* the browser's own leave beacon still runs */ }
  }

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.status(500).json({ error: 'VAPID keys not configured' });
  }

  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
  const rest = async (path) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
    if (!r.ok) throw new Error(`${path.split('?')[0]} read failed (${r.status})`);
    return r.json();
  };
  const nameOf = async (id) => {
    if (!P.isUuid(id)) return 'Someone';
    const [p] = await rest(`profiles?id=eq.${id}&select=full_name,email`);
    return (p && (p.full_name || p.email)) || 'Someone';
  };
  const groupNameOf = async (id) => {
    if (!P.isUuid(id)) return '';
    const [c] = await rest(`conversations?id=eq.${id}&select=name`);
    return (c && c.name) || 'Group';
  };

  // Push to every device of these people. payloadFor(userId) may return null to skip someone.
  async function pushTo(userIds, payloadFor, { ttl, urgency }) {
    const ids = [...new Set(userIds)].filter(P.isUuid);
    if (!ids.length) return { sent: 0, cleaned: 0 };
    const subs = await rest(`push_subscriptions?user_id=in.(${ids.join(',')})&select=*`);
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    let sent = 0, cleaned = 0;
    await Promise.all(subs.map(async s => {
      const payload = payloadFor(s.user_id);
      if (!payload) return;
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ ...payload, from: caller.id }),
          { TTL: ttl, urgency }
        );
        sent++;
      } catch (e) {
        const code = e?.statusCode;
        if (code === 404 || code === 410) {
          cleaned++;
          try {
            await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, {
              method: 'DELETE', headers: H
            });
          } catch {}
        }
      }
    }));
    return { sent, cleaned };
  }

  try {
    if (action === 'subscribe') {
      const sub = body.subscription || {};
      const endpoint = String(sub.endpoint || '');
      const p256dh = String(sub.keys?.p256dh || '');
      const auth = String(sub.keys?.auth || '');
      if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: 'Invalid subscription' });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?on_conflict=endpoint`, {
        method: 'POST',
        headers: { ...H, Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          user_id: caller.id,
          endpoint, p256dh, auth,
          user_agent: String(body.user_agent || '').slice(0, 300)
        })
      });
      if (!r.ok) return res.status(502).json({ error: 'subscribe_failed', detail: (await r.text()).slice(0, 200) });
      return res.status(200).json({ success: true });
    }

    if (action === 'unsubscribe') {
      const endpoint = String(body.endpoint || '');
      if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
      await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}&user_id=eq.${caller.id}`, {
        method: 'DELETE', headers: H
      });
      return res.status(200).json({ success: true });
    }

    if (action === 'message') {
      const id = Number(body.message_id);
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'message_id required' });
      const [message] = await rest(`messages?id=eq.${id}&select=*`);
      if (!message) return res.status(404).json({ error: 'Message not found' });
      if (!P.mayPushMessage(message, caller.id)) return res.status(403).json({ error: 'Only the sender can announce a new message' });
      let members = [], groupName = '';
      if (message.conversation_id) {
        [members, groupName] = await Promise.all([
          rest(`conversation_members?conversation_id=eq.${message.conversation_id}&select=user_id,muted`),
          groupNameOf(message.conversation_id),
        ]);
      }
      const senderName = await nameOf(message.sender_id);
      const r = await pushTo(P.messageRecipients(message, members),
        uid => P.messagePush({ message, senderName, groupName, recipientId: uid }), { ttl: 3600, urgency: 'normal' });
      return res.status(200).json({ success: true, ...r });
    }

    if (action === 'call' || action === 'call-end') {
      const id = String(body.call_id || '');
      if (!P.isUuid(id)) return res.status(400).json({ error: 'call_id required' });
      const [call] = await rest(`calls?id=eq.${id}&select=*`);
      if (!call) return res.status(404).json({ error: 'Call not found' });
      const parts = await rest(`call_participants?call_id=eq.${id}&select=user_id,role,state,joined_at`);
      const [callerName, groupName] = await Promise.all([nameOf(call.created_by), call.conversation_id ? groupNameOf(call.conversation_id) : '']);
      if (action === 'call') {
        if (!P.mayPushCall(call, caller.id)) return res.status(403).json({ error: 'Only the caller can ring, while the call is ringing' });
        const payload = P.callPush({ call, callerName, groupName });
        const r = await pushTo(P.callRecipients(parts), () => payload, { ttl: 45, urgency: 'high' });
        return res.status(200).json({ success: true, ...r });
      }
      if (!P.mayPushCallEnd(parts, caller.id)) return res.status(403).json({ error: 'Not in this call' });
      const byUser = new Map(parts.map(p => [p.user_id, p]));
      const r = await pushTo(parts.map(p => p.user_id),
        uid => P.callEndPush({ call, participant: byUser.get(uid), callerName, groupName }), { ttl: 120, urgency: 'high' });
      return res.status(200).json({ success: true, ...r });
    }

    if (action === 'notify') {
      // Push a notification to another employee's subscribed devices.
      const to = String(body.to || '');
      if (!P.isUuid(to)) return res.status(400).json({ error: 'to (user id) required' });
      const tag = String(body.tag || 'worksuite').slice(0, 60);
      const payload = {
        title: String(body.title || 'WorkSuite').slice(0, 100),
        body: String(body.body || '').slice(0, 300),
        url: String(body.url || '/chat/').slice(0, 200),
        tag,
      };
      const r = await pushTo([to], () => payload, { ttl: tag === 'call' ? 40 : 3600, urgency: tag === 'call' ? 'high' : 'normal' });
      return res.status(200).json({ success: true, ...r, ...(r.sent ? {} : { reason: 'no_subscriptions' }) });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e.message || e).slice(0, 200) });
  }
};
