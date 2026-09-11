// Push notifications for messages and calls (lib/comms-push.js): who may ask
// for one, who receives it, and what it says — decided from database rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/comms-push');

const A = '11111111-1111-4111-8111-111111111111';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const G = '55555555-5555-4555-8555-555555555555';
const CALL = '66666666-6666-4666-8666-666666666666';
const NOW = Date.parse('2026-09-11T10:00:00Z');

test('only the sender may push their own message, and only while it is fresh', () => {
  const m = { sender_id: A, created_at: '2026-09-11T09:58:00Z' };
  assert.equal(P.mayPushMessage(m, A, NOW), true);
  assert.equal(P.mayPushMessage(m, C, NOW), false, 'someone else cannot replay it');
  assert.equal(P.mayPushMessage({ ...m, created_at: '2026-09-11T09:00:00Z' }, A, NOW), false, 'an hour-old message is not pushed again');
  assert.equal(P.mayPushMessage(null, A, NOW), false);
});

test('a direct message goes to its recipient with the sender as the title', () => {
  const m = { id: 9, sender_id: A, recipient_id: C, conversation_id: null, body: 'Measurements   are\nin', created_at: '2026-09-11T09:59:00Z' };
  assert.deepEqual(P.messageRecipients(m), [C]);
  assert.deepEqual(P.messagePush({ message: m, senderName: 'Anil Kumar', recipientId: C }),
    { type: 'message', title: 'Anil Kumar', body: 'Measurements are in', url: `/chat/#thread=${A}`, tag: `dm-${A}` });
});

test('a group message reaches unmuted members except the sender; a mention cuts through mute', () => {
  const m = { sender_id: A, conversation_id: G, body: 'hi @Chitra Rao', mentions: [C] };
  const members = [{ user_id: A }, { user_id: C, muted: true }, { user_id: D, muted: true }, { user_id: 'x', muted: false }];
  assert.deepEqual(P.messageRecipients(m, members), [C, 'x']);
  const toC = P.messagePush({ message: m, senderName: 'Anil Kumar', groupName: 'Acme team', recipientId: C });
  assert.equal(toC.title, 'Anil Kumar mentioned you in Acme team');
  assert.equal(toC.tag, `grp-${G}`);
  const toX = P.messagePush({ message: m, senderName: 'Anil Kumar', groupName: 'Acme team', recipientId: 'x' });
  assert.equal(toX.title, 'Acme team');
  assert.equal(toX.body, 'Anil: hi @Chitra Rao');
});

test('files read as a photo or an attachment; call logs and deletions never buzz', () => {
  const photo = P.messagePush({ message: { sender_id: A, recipient_id: C, body: `__FILE__::${A}/1-x.png::image/png::100::x.png` }, senderName: 'Anil' });
  assert.match(photo.body, /Photo/);
  assert.doesNotMatch(photo.body, /__FILE__/);
  assert.equal(P.messagePush({ message: { sender_id: A, recipient_id: C, body: '__CALL__::audio::missed::0' }, senderName: 'Anil' }), null);
  assert.equal(P.messagePush({ message: { sender_id: A, recipient_id: C, body: '__DELETED__' }, senderName: 'Anil' }), null);
});

test('only the caller rings, only while ringing, and only people still being rung', () => {
  const call = { id: CALL, created_by: A, status: 'ringing', media: 'video' };
  assert.equal(P.mayPushCall(call, A), true);
  assert.equal(P.mayPushCall(call, C), false);
  assert.equal(P.mayPushCall({ ...call, status: 'active' }, A), false);
  const parts = [{ user_id: A, role: 'caller', state: 'joined' }, { user_id: C, role: 'callee', state: 'ringing' },
                 { user_id: D, role: 'callee', state: 'busy' }, { user_id: 'x', role: 'callee', state: 'invited' }];
  assert.deepEqual(P.callRecipients(parts), [C, 'x']);
  assert.deepEqual(P.callPush({ call, callerName: 'Anil Kumar' }),
    { type: 'call', call_id: CALL, title: '📞 Incoming video call', body: 'Anil Kumar is calling you', url: `/call/?id=${CALL}`, tag: `call-${CALL}` });
});

test('after a call: missed for those who never answered, a silent close for the rest, nothing while still ringing', () => {
  const ended = { id: CALL, created_by: A, status: 'missed', media: 'audio', conversation_id: null };
  const missed = P.callEndPush({ call: ended, participant: { user_id: C, role: 'callee', state: 'missed' }, callerName: 'Anil' });
  assert.deepEqual(missed, { type: 'call-end', call_id: CALL, title: 'Missed voice call', body: 'from Anil', url: `/chat/#thread=${A}`, tag: `call-${CALL}` });
  const answered = P.callEndPush({ call: { ...ended, status: 'active' }, participant: { user_id: C, role: 'callee', state: 'joined', joined_at: 'x' } });
  assert.equal(answered.close, true);
  assert.equal(P.callEndPush({ call: { ...ended, status: 'ringing' }, participant: { user_id: C, role: 'callee', state: 'ringing' } }), null);
  assert.equal(P.callEndPush({ call: ended, participant: { user_id: A, role: 'caller', state: 'left' } }), null, 'the caller is never told they missed their own call');
  const group = P.callEndPush({ call: { ...ended, conversation_id: 'G' }, participant: { user_id: C, role: 'callee', state: 'missed' }, callerName: 'Anil', groupName: 'Ops' });
  assert.equal(group.url, '/chat/#group=G');
  assert.equal(group.body, 'from Anil · Ops');
  assert.equal(P.mayPushCallEnd([{ user_id: C }], C), true);
  assert.equal(P.mayPushCallEnd([{ user_id: C }], D), false);
});

test('ids are checked before they reach a query string', () => {
  assert.equal(P.isUuid(CALL), true);
  assert.equal(P.isUuid(`${CALL}&select=*`), false);
  assert.equal(P.isUuid(42), false);
});
