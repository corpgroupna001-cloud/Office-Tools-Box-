// Builds the Web Push notifications for messages and calls from database rows,
// so the text a colleague's phone shows is decided by the server from what is
// really in the database, not typed by the sending browser. Pure: api/push.js
// fetches the rows, checks who is asking, and sends.
'use strict';
const { previewText, parseSpecial } = require('../chat/chat-logic');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = v => typeof v === 'string' && UUID.test(v);

function clip(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
const firstName = n => clip(String(n || '').trim().split(/\s+/)[0] || 'Someone', 40);
const kindWord = media => (media === 'video' ? 'video' : 'voice');

/** Only the sender may push their own message, and only while it is fresh (no replaying old ones). */
function mayPushMessage(message, callerId, nowMs = Date.now()) {
  if (!message || message.sender_id !== callerId) return false;
  const at = Date.parse(message.created_at);
  return Number.isFinite(at) && nowMs - at < 10 * 60 * 1000;
}

/** Who hears about a message: the DM recipient, or every unmuted group member but the sender (mentions cut through mute). */
function messageRecipients(message, members = []) {
  if (!message) return [];
  if (!message.conversation_id) return message.recipient_id && message.recipient_id !== message.sender_id ? [message.recipient_id] : [];
  const mentions = new Set(Array.isArray(message.mentions) ? message.mentions : []);
  return members
    .filter(m => m && m.user_id && m.user_id !== message.sender_id && (!m.muted || mentions.has(m.user_id)))
    .map(m => m.user_id);
}

/** The notification for one recipient, or null when the message is not worth a buzz (call logs, deletions). */
function messagePush({ message, senderName, groupName, recipientId }) {
  const special = parseSpecial(message.body);
  if (special.kind === 'call' || special.kind === 'deleted') return null;
  const preview = previewText(message.body);
  const sender = senderName || 'Someone';
  if (message.conversation_id) {
    const group = groupName || 'Group';
    const mentioned = Array.isArray(message.mentions) && message.mentions.includes(recipientId);
    return {
      type: 'message',
      title: clip(mentioned ? `${sender} mentioned you in ${group}` : group, 100),
      body: clip(mentioned ? preview : `${firstName(sender)}: ${preview}`, 300),
      url: `/chat/#group=${message.conversation_id}`,
      tag: `grp-${message.conversation_id}`,
    };
  }
  return {
    type: 'message',
    title: clip(sender, 100),
    body: clip(preview, 300),
    url: `/chat/#thread=${message.sender_id}`,
    tag: `dm-${message.sender_id}`,
  };
}

/** Only the caller rings people, and only while the call is still ringing. */
function mayPushCall(call, callerId) {
  return !!call && call.created_by === callerId && call.status === 'ringing';
}

/** The callees whose devices should ring. */
function callRecipients(participants = []) {
  return participants.filter(p => p.role === 'callee' && (p.state === 'invited' || p.state === 'ringing')).map(p => p.user_id);
}

function callPush({ call, callerName, groupName }) {
  const who = callerName || 'Someone';
  return {
    type: 'call',
    call_id: call.id,
    title: `📞 Incoming ${kindWord(call.media)} call`,
    body: clip(groupName ? `${who} · ${groupName}` : `${who} is calling you`, 200),
    url: `/call/?id=${call.id}`,
    tag: `call-${call.id}`,
  };
}

/** Anyone in the call may clear its ringing notifications (answered on the desktop while the phone rang). */
function mayPushCallEnd(participants = [], callerId) {
  return participants.some(p => p.user_id === callerId);
}

/**
 * What replaces the "Incoming call" notification on one callee's devices:
 * "Missed call" once a call they never answered is over; otherwise a silent
 * close (they answered, declined, or are still ringing on another device).
 * null = leave their notification alone (still ringing, call still live).
 */
function callEndPush({ call, participant, callerName, groupName }) {
  if (!participant || participant.role !== 'callee') return null;
  const live = call.status === 'ringing' || call.status === 'active';
  const pending = participant.state === 'invited' || participant.state === 'ringing';
  if (live && pending) return null;
  const tag = `call-${call.id}`;
  const missed = !live && (participant.state === 'missed' || participant.state === 'busy') && !participant.joined_at;
  if (!missed) return { type: 'call-end', call_id: call.id, close: true, title: 'Call ended', body: '', url: '/chat/', tag };
  const who = callerName || 'Someone';
  return {
    type: 'call-end',
    call_id: call.id,
    title: `Missed ${kindWord(call.media)} call`,
    body: clip(groupName ? `from ${who} · ${groupName}` : `from ${who}`, 200),
    url: call.conversation_id ? `/chat/#group=${call.conversation_id}` : `/chat/#thread=${call.created_by}`,
    tag,
  };
}

module.exports = {
  isUuid, clip, mayPushMessage, messageRecipients, messagePush,
  mayPushCall, callRecipients, callPush, mayPushCallEnd, callEndPush,
};
