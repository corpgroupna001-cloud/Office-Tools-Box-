// ICE server selection for calls (lib/ice-servers.js): provider order,
// fallbacks, coturn REST credentials and clean-up of what providers return.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iceServersFor, coturnCredentials, normalise, STUN } = require('../lib/ice-servers');

const USER = '11111111-1111-4111-8111-111111111111';
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const opts = (fetchImpl, now = () => 1_800_000_000_000) => ({ fetchImpl, now, cache: false });

test('with nothing configured it answers public STUN only and says there is no relay', async () => {
  const r = await iceServersFor(USER, {}, opts(async () => { throw new Error('must not fetch'); }));
  assert.equal(r.provider, 'stun');
  assert.equal(r.relay, false);
  assert.deepEqual(r.iceServers, [STUN]);
});

test('Cloudflare: the ICE-server list is used, port 53 dropped, and the token is sent as a bearer', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return reply(201, { iceServers: [
      { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' },
    ] });
  };
  const r = await iceServersFor(USER, { CLOUDFLARE_TURN_KEY_ID: 'key1', CLOUDFLARE_TURN_API_TOKEN: 'tok' }, opts(fetchImpl));
  assert.equal(r.provider, 'cloudflare');
  assert.equal(r.relay, true);
  assert.match(calls[0].url, /\/v1\/turn\/keys\/key1\/credentials\/generate-ice-servers$/);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(JSON.parse(calls[0].init.body).ttl, 43200);
  const all = r.iceServers.flatMap(s => s.urls);
  assert.ok(!all.some(u => /:53(\?|$)/.test(u)), 'no port-53 URLs');
  assert.ok(all.includes('turns:turn.cloudflare.com:443?transport=tcp'));
});

test('Cloudflare: the older single-object answer still works', async () => {
  const fetchImpl = async url => /generate-ice-servers$/.test(url) ? reply(404, {})
    : reply(201, { iceServers: { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c' } });
  const r = await iceServersFor(USER, { CLOUDFLARE_TURN_KEY_ID: 'k', CLOUDFLARE_TURN_API_TOKEN: 't' }, opts(fetchImpl));
  assert.equal(r.provider, 'cloudflare');
  assert.deepEqual(r.iceServers[0], STUN, 'public STUN is added when the provider only returns TURN');
  assert.equal(r.iceServers[1].username, 'u');
});

test('a failing provider falls through to the next one', async () => {
  const fetchImpl = async url => {
    if (url.includes('cloudflare')) throw new Error('network down');
    return reply(200, [{ urls: 'stun:stun.relay.metered.ca:80' }, { urls: 'turn:global.relay.metered.ca:443', username: 'm', credential: 'p' }]);
  };
  const r = await iceServersFor(USER, {
    CLOUDFLARE_TURN_KEY_ID: 'k', CLOUDFLARE_TURN_API_TOKEN: 't',
    METERED_TURN_DOMAIN: 'https://acme.metered.live/', METERED_TURN_API_KEY: 'a b',
  }, opts(fetchImpl));
  assert.equal(r.provider, 'metered');
  assert.equal(r.relay, true);
  assert.deepEqual(r.iceServers[0].urls, ['stun:stun.relay.metered.ca:80']);
});

test('own coturn with a shared secret gets time-limited REST credentials', async () => {
  const now = () => 1_800_000_000_000;
  const r = await iceServersFor(USER, { TURN_URLS: 'turn:turn.example.com:3478, turns:turn.example.com:5349', TURN_SECRET: 's3cret', TURN_TTL_SECONDS: '3600' }, opts(null, now));
  assert.equal(r.provider, 'coturn');
  const turn = r.iceServers.find(s => s.username);
  assert.equal(turn.username, `${1_800_000_000 + 3600}:${USER}`);
  assert.equal(turn.credential, crypto.createHmac('sha1', 's3cret').update(turn.username).digest('base64'));
  assert.deepEqual(turn.urls, ['turn:turn.example.com:3478', 'turns:turn.example.com:5349']);
  assert.deepEqual(coturnCredentials('s3cret', USER, 3600, 1_800_000_000), { username: turn.username, credential: turn.credential });
});

test('static TURN credentials, and nothing half-configured is handed out', async () => {
  const r = await iceServersFor(USER, { TURN_URLS: 'turn:t.example.com:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' }, opts(null));
  assert.equal(r.provider, 'static');
  assert.equal(r.relay, true);
  const half = await iceServersFor(USER, { TURN_URLS: 'turn:t.example.com:3478', TURN_USERNAME: 'u' }, opts(null));
  assert.equal(half.provider, 'stun', 'a URL without a credential is not offered');
});

test('the TTL is kept within sane bounds', async () => {
  const low = await iceServersFor(USER, { TURN_TTL_SECONDS: '5' }, opts(null));
  const high = await iceServersFor(USER, { TURN_TTL_SECONDS: String(10 * 86400) }, opts(null));
  assert.equal(low.ttl, 600);
  assert.equal(high.ttl, 48 * 3600);
});

test('normalise drops junk entries and non-ICE URLs', () => {
  assert.deepEqual(normalise([null, 5, {}, { urls: 'http://x' }, { url: 'stun:a:1' }, { urls: ['turn:b:3478'], username: 'u', credential: 'c', extra: 1 }]),
    [{ urls: ['stun:a:1'] }, { urls: ['turn:b:3478'], username: 'u', credential: 'c' }]);
  assert.deepEqual(normalise(undefined), []);
});
