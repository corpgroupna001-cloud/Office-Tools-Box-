// Messenger's pure helpers (chat/chat-logic.js): message formats, previews,
// grouping, IST day labels, mentions, durations and safe file names. The same
// module builds push text on the server, so these are its contract too.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../chat/chat-logic');

test('parseSpecial reads the stored message formats', () => {
  assert.deepEqual(L.parseSpecial('hello'), { kind: 'text', text: 'hello' });
  assert.deepEqual(L.parseSpecial('__DELETED__'), { kind: 'deleted' });
  const f = L.parseSpecial('__FILE__::u1/1-ab-report.pdf::application/pdf::2048::Q3 report::final.pdf');
  assert.equal(f.kind, 'file');
  assert.equal(f.path, 'u1/1-ab-report.pdf');
  assert.equal(f.size, 2048);
  assert.equal(f.name, 'Q3 report::final.pdf', 'a name containing :: survives');
  assert.equal(f.isImage, false);
  assert.equal(L.parseSpecial('__FILE__::p::image/png::10::a.png').isImage, true);
  assert.equal(L.parseSpecial('__FILE__::p::audio/webm;codecs=opus::10::voice-note.webm').isAudio, true);
  assert.deepEqual(L.parseSpecial('__CALL__::video::completed::125'), { kind: 'call', media: 'video', status: 'completed', seconds: 125 });
  assert.deepEqual(L.parseSpecial('__CALL__::audio::missed::'), { kind: 'call', media: 'audio', status: 'missed', seconds: 0 });
  assert.equal(L.parseSpecial('__FILE__::broken').kind, 'text', 'a malformed file body is shown as text, not dropped');
  assert.equal(L.parseSpecial(null).kind, 'text');
});

test('previewText never shows raw storage paths or markers', () => {
  assert.equal(L.previewText('__FILE__::u/p.png::image/png::1::p.png'), '📷 Photo');
  assert.equal(L.previewText('__FILE__::u/v.webm::audio/webm::1::voice-note.webm'), '🎤 Voice message');
  assert.equal(L.previewText('__FILE__::u/d.pdf::application/pdf::1::Deck.pdf'), '📎 Deck.pdf');
  assert.equal(L.previewText('__DELETED__'), '🗑️ Message deleted');
  assert.equal(L.previewText('__CALL__::audio::missed::0'), '📞 Missed voice call');
  assert.equal(L.previewText('__CALL__::video::completed::125'), '📹 Video call · 2m 5s');
  assert.equal(L.previewText('  line one\n\n line two '), 'line one line two');
  const long = L.previewText('x'.repeat(300));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
});

test('call labels speak from the reader’s side; only the person who missed it sees red', () => {
  const missed = { media: 'audio', status: 'missed', seconds: 0 };
  assert.deepEqual(L.callLabel(missed, false), { icon: '📞', text: 'Missed voice call', missed: true });
  assert.deepEqual(L.callLabel(missed, true), { icon: '📞', text: 'Voice call · No answer', missed: false });
  assert.equal(L.callLabel({ media: 'video', status: 'completed', seconds: 65 }, true).text, 'Video call · 1m 5s');
  assert.equal(L.callLabel({ media: 'audio', status: 'declined', seconds: 0 }, false).text, 'You declined a voice call');
  assert.equal(L.callLabel({ media: 'audio', status: 'busy', seconds: 0 }, false).missed, true);
});

test('durations and clocks', () => {
  assert.equal(L.fmtDuration(0), '0s');
  assert.equal(L.fmtDuration(45), '45s');
  assert.equal(L.fmtDuration(125), '2m 5s');
  assert.equal(L.fmtDuration(3720), '1h 2m');
  assert.equal(L.fmtClock(72), '1:12');
  assert.equal(L.fmtClock(3725), '1:02:05');
  assert.equal(L.fmtBytes(0), '');
  assert.equal(L.fmtBytes(2048), '2 KB');
  assert.equal(L.fmtBytes(5 * 1024 * 1024), '5.0 MB');
});

test('day labels follow the IST calendar', () => {
  const now = new Date('2026-09-11T10:00:00+05:30');
  assert.equal(L.dayLabel('2026-09-11T00:30:00+05:30', now), 'Today');
  assert.equal(L.dayLabel('2026-09-10T23:59:00+05:30', now), 'Yesterday');
  assert.equal(L.dayLabel('2026-09-10T20:00:00Z', now), 'Today', '01:30 IST on the 11th is today in India');
  assert.equal(L.dayLabel('2026-09-07T12:00:00+05:30', now), 'Monday');
  assert.equal(L.dayLabel('2026-08-01T12:00:00+05:30', now), '1 August 2026');
  assert.equal(L.dayKey('2026-09-10T20:00:00Z'), '2026-09-11');
  assert.equal(L.fmtListTime('2026-09-11T09:58:30+05:30', now), '1m');
  assert.equal(L.fmtListTime('2026-09-10T09:00:00+05:30', now), 'Yesterday');
  assert.equal(L.fmtListTime('2026-08-01T09:00:00+05:30', now), '1 Aug');
});

test('bursts group one sender’s messages; a day change or a call log breaks them', () => {
  const m = (id, s, t, body = 'x') => ({ id, sender_id: s, body, created_at: `2026-09-11T${t}:00+05:30` });
  const list = [m(1, 'a', '10:00'), m(2, 'a', '10:01'), m(3, 'b', '10:01'), m(4, 'b', '10:30'), m(5, 'b', '10:31', '__CALL__::audio::missed::0')];
  const f = list.map((_, i) => L.groupFlags(list, i));
  assert.deepEqual(f.map(x => [x.first, x.last]), [[true, false], [false, true], [true, true], [true, true], [true, true]]);
  assert.equal(f[0].newDay, true);
  assert.equal(f[1].newDay, false);
  const across = [m(1, 'a', '23:59'), { id: 2, sender_id: 'a', body: 'x', created_at: '2026-09-12T00:00:30+05:30' }];
  assert.equal(L.sameBurst(across[0], across[1]), false);
  assert.equal(L.groupFlags(across, 1).newDay, true);
});

test('stored messages sort by id; unsent ones follow in the order written', () => {
  const list = [{ client_id: 'c2', created_at: '2026-09-11T10:02:00Z' }, { id: 9, created_at: '2026-09-11T10:03:00Z' }, { id: 3 }, { client_id: 'c1', created_at: '2026-09-11T10:01:00Z' }];
  list.sort(L.compareMessages);
  assert.deepEqual(list.map(x => x.id || x.client_id), [3, 9, 'c1', 'c2']);
});

test('formatBody escapes everything, links URLs and highlights mentions', () => {
  const html = L.formatBody('<img src=x onerror=alert(1)> see https://example.com/a?b=1&c=2. @Anil Kumar\nbye', { names: ['Anil Kumar', 'Anil'], meName: 'Maya' });
  assert.ok(!html.includes('<img'), 'markup is escaped');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('<a class="mx-link" href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">'), html);
  assert.ok(html.includes('</a>.'), 'trailing punctuation stays outside the link');
  assert.ok(html.includes('<span class="mx-mention">@Anil Kumar</span>'), 'the longest name wins');
  assert.ok(html.includes('<br>bye'));
  assert.ok(L.formatBody('"><script>', {}).startsWith('&quot;&gt;&lt;script&gt;'));
  assert.ok(L.formatBody('hi @Maya', { names: ['Maya'], meName: 'Maya' }).includes('mx-mention me'));
  assert.equal(L.firstUrl('go to https://x.test/p). now'), 'https://x.test/p');
  assert.equal(L.firstUrl('no links'), null);
});

test('mentions: parsed as whole names, and the picker finds the term before the caret', () => {
  const people = [{ id: 'a', name: 'Anil' }, { id: 'ak', name: 'Anil Kumar' }, { id: 'c', name: 'Chitra Rao' }];
  assert.deepEqual(L.mentionIdsIn('hi @Anil Kumar and @Chitra Rao', people).sort(), ['ak', 'c']);
  assert.deepEqual(L.mentionIdsIn('mail anil@Anilx.com', people), []);
  assert.deepEqual(L.mentionIdsIn('@Anil, ping', people), ['a']);
  assert.deepEqual(L.mentionQuery('hello @Chi', 10), { start: 6, term: 'Chi' });
  assert.equal(L.mentionQuery('mail@x', 6), null, 'an email address is not a mention');
  assert.equal(L.mentionQuery('no at sign', 10), null);
});

test('file names and storage paths are safe', () => {
  assert.equal(L.safeFileName('My Report (final).pdf'), 'My_Report_final_.pdf');
  assert.equal(L.safeFileName('../../etc/passwd'), 'etc_passwd');
  assert.equal(L.safeFileName(''), 'file');
  const long = L.safeFileName('a'.repeat(200) + '.xlsx');
  assert.equal(long.length, 80);
  assert.ok(long.endsWith('.xlsx'));
  assert.equal(L.storagePath('u1', 'a b.png', 1700000000000, 'abc123'), 'u1/1700000000000-abc123-a_b.png');
  assert.equal(L.fileBody('u1/p.png', 'image/png', 12, 'p.png'), '__FILE__::u1/p.png::image/png::12::p.png');
});

test('thread helpers', () => {
  assert.equal(L.dmTopicKey('b', 'a'), L.dmTopicKey('a', 'b'));
  const members = [{ user_id: 'me', last_read_at: '2026-09-11T10:05:00Z' }, { user_id: 'x', last_read_at: '2026-09-11T10:05:00Z' }, { user_id: 'y', last_read_at: '2026-09-11T09:00:00Z' }, { user_id: 'z', last_read_at: null }];
  assert.deepEqual(L.seenBy(members, 'me', '2026-09-11T10:00:00Z'), ['x']);
  assert.equal(L.searchTerm('50% off, (today)*'), '50 off today');
  assert.equal(L.initials('Anil Kumar Rao'), 'AR');
  assert.equal(L.initials(''), '?');
  assert.equal(L.colorFor('Anil'), L.colorFor('Anil'));
  assert.equal(L.isEmojiOnly('👍'), true);
  assert.equal(L.isEmojiOnly('👍 ok'), false);
  assert.equal(L.isEmojiOnly('123'), false);
});

test('an unknown column is recognised however PostgREST reports it', () => {
  assert.equal(L.isMissingColumn({ code: '42703' }), true);
  assert.equal(L.isMissingColumn({ code: 'PGRST204', message: "Could not find the 'client_id' column of 'messages' in the schema cache" }), true);
  assert.equal(L.isMissingColumn({ message: "Could not find the 'pinned_at' column of 'messages' in the schema cache" }), true);
  assert.equal(L.isMissingColumn({ code: '42501', message: 'new row violates row-level security policy' }), false);
  assert.equal(L.isMissingColumn(null), false);
});

test('transient errors are retried; refusals and cancellations are not', () => {
  assert.equal(L.isTransientError({ message: 'AbortError: signal timed out', code: '20' }, true), true, 'an aborted fetch carries code 20');
  assert.equal(L.isTransientError({ message: 'TypeError: Failed to fetch', code: '' }, true), true);
  assert.equal(L.isTransientError({ message: 'JWT expired', code: 'PGRST301' }, true), true);
  assert.equal(L.isTransientError({ message: 'Bad gateway', status: 502 }, true), true);
  assert.equal(L.isTransientError({ message: 'anything' }, false), true, 'offline is always worth retrying');
  assert.equal(L.isTransientError({ message: 'new row violates row-level security policy', code: '42501' }, true), false);
  assert.equal(L.isTransientError({ code: 'PGRST204', message: "Could not find the 'x' column" }, true), false);
  assert.equal(L.isTransientError({ cancelled: true, transient: true }, false), false);
});

test('upload time limits scale with size and are capped', () => {
  assert.equal(L.uploadTimeoutMs(0), 30000);
  assert.equal(L.uploadTimeoutMs(256000), 40000);
  assert.equal(L.uploadTimeoutMs(25 * 1024 * 1024), 600000);
});

test('a re-fetch prunes only rows it can prove were deleted', () => {
  const at = 1000;
  const list = [{ id: 5 }, { id: 8 }, { id: 9 }, { id: 10 }, { id: 11, _addedAt: 1500 }, { client_id: 'c', id: null }];
  // The fetch started knowing ids up to 10 and returned 8 and 10: 9 was deleted, 5 is older than the page, 11 arrived meanwhile.
  assert.deepEqual(L.keepAfterRefetch(list, [{ id: 8 }, { id: 10 }], { maxId: 10, at }).map(m => m.id || m.client_id), [5, 8, 10, 11, 'c']);
  // The newest stored message was deleted: 10 is gone even though it is above the fetched maximum.
  assert.deepEqual(L.keepAfterRefetch([{ id: 8 }, { id: 10 }], [{ id: 8 }], { maxId: 10, at }).map(m => m.id), [8]);
  // A reconciled send with an id above the snapshot stays.
  assert.deepEqual(L.keepAfterRefetch([{ id: 8 }, { id: 12 }], [{ id: 8 }], { maxId: 8, at }).map(m => m.id), [8, 12]);
  // The thread came back empty: everything stored before the fetch goes, unsent stays.
  assert.deepEqual(L.keepAfterRefetch([{ id: 3 }, { id: null, client_id: 'p' }], [], { maxId: 3, at }).map(m => m.id || m.client_id), ['p']);
});

test('the group read marker uses the server’s created_at of the newest stored message', () => {
  const list = [{ id: 1, created_at: '2026-09-11T10:00:00.123456+00:00' }, { id: 2, created_at: '2026-09-11T10:05:00.5+00:00' }, { id: null, client_id: 'x', created_at: '2026-09-11T10:09:00Z' }];
  assert.equal(L.readMarker(list, 'fallback'), '2026-09-11T10:05:00.5+00:00');
  assert.equal(L.readMarker([{ id: null, created_at: 'x' }], 'fallback'), 'fallback');
});

test('my realtime echo is matched only to the send in flight', () => {
  const inFlight = { id: null, _state: 'pending', _inFlight: true, body: 'ok' };
  const waiting = { id: null, _state: 'pending', body: 'ok' };
  const failed = { id: null, _state: 'failed', body: 'ok' };
  assert.equal(L.findEchoTarget([failed, waiting, inFlight], { id: 9, body: 'ok' }), inFlight);
  assert.equal(L.findEchoTarget([failed, waiting], { id: 9, body: 'ok' }), null, 'the same text from another device is a new message');
  assert.equal(L.findEchoTarget([inFlight], { id: 9, body: 'other' }), null);
});
