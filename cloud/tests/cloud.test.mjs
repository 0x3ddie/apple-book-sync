import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { getMigrations } from 'better-auth/db/migration';
import { createAuth } from '../auth.mjs';
import { createCloudHandler, createHandler } from '../handler.mjs';
import { PostgresStore } from '../store.mjs';

const origin = 'https://reader.example';
let database, pool, auth, handle, time;
const emails = [];
const accounts = new Map();

// PGlite runs PostgreSQL itself in-process. This adapter supplies pg's small
// query/connect interface and serializes its single connection for transactions.
function postgresPool(db) {
  let next = Promise.resolve();
  return {
    async connect() {
      const previous = next;
      let release;
      next = new Promise((resolve) => { release = resolve; });
      await previous;
      return {
        async query(sql, parameters = []) {
          const result = await db.query(sql, parameters);
          return { ...result, rowCount: result.affectedRows ?? result.rows.length, command: sql.trim().split(/\s+/)[0].toUpperCase() };
        },
        release,
      };
    },
    async query(sql, parameters) {
      const client = await this.connect();
      try { return await client.query(sql, parameters); } finally { client.release(); }
    },
    async end() {},
  };
}

function request(path, { cookie, bearer, body, originHeader = origin, accountHeader, method, headers = {}, ip = '203.0.113.7' } = {}) {
  method ??= body === undefined ? 'GET' : 'POST';
  const builtHeaders = new Headers(headers);
  builtHeaders.set('x-books-client-ip', ip);
  if (cookie) builtHeaders.set('cookie', cookie);
  if (accountHeader !== null && (accountHeader ?? accounts.get(cookie))) builtHeaders.set('x-books-account', accountHeader ?? accounts.get(cookie));
  if (bearer) builtHeaders.set('authorization', `Bearer ${bearer}`);
  if (method === 'POST' && originHeader !== null) builtHeaders.set('origin', originHeader);
  if (body !== undefined) builtHeaders.set('content-type', 'application/json');
  return new Request(`${origin}${path}`, { method, headers: builtHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function call(path, options) {
  const response = await handle(request(path, options));
  return { status: response.status, body: await response.json(), response };
}

async function login(email = 'alice@example.test', ip = '203.0.113.7') {
  const sent = await call('/api/auth/sign-in/magic-link', { body: { email, callbackURL: '/' }, ip });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const message = emails.at(-1);
  assert.equal(message.email, email);
  const result = await handle(new Request(message.url, { headers: { 'x-books-client-ip': ip } }));
  assert.equal(result.status, 302);
  const sessionCookie = result.headers.getSetCookie().find((value) => value.includes('session_token='));
  assert.match(sessionCookie, /; Secure/i); assert.match(sessionCookie, /; HttpOnly/i); assert.match(sessionCookie, /; SameSite=Lax/i);
  assert.match(sessionCookie, /; Max-Age=2592000(?:;|$)/i);
  const cookie = result.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  assert.ok(cookie.includes('session_token='));
  const session = (await call('/api/session', { cookie })).body;
  accounts.set(cookie, session.user.id);
  return { cookie, url: message.url, session };
}

const startPairing = (name = 'Test Mac', options = {}) => call('/api/devices/pairing/start', { originHeader: null, body: { name }, ...options });
const pollPairing = (secret, options = {}) => call('/api/devices/pairing/poll', { originHeader: null, body: { secret }, ...options });
const completePairing = (secret, accountId, approve = true, options = {}) => call('/api/devices/pairing/complete', {
  originHeader: null, body: { secret, accountId, approve }, ...options,
});
const claimPairing = (cookie, code, options = {}) => call('/api/devices/pairing', { cookie, body: { code }, ...options });

async function pair(cookie, name = 'Test Mac') {
  const created = await startPairing(name);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const claimed = await claimPairing(cookie, created.body.code);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const pending = await pollPairing(created.body.secret);
  assert.equal(pending.body.status, 'claimed');
  const completed = await completePairing(created.body.secret, pending.body.account.id);
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.device.id, claimed.body.deviceId);
  return { ...completed.body, secret: created.body.secret, code: created.body.code };
}

const book = (overrides = {}) => ({
  id: 'BOOK1', title: 'Private book', author: 'Writer', progress: 0.2,
  lastReadAt: '2026-11-14T00:00:00.000Z', availableOnMac: true,
  applePosition: { cfi: 'epubcfi(/6/2!/4/2:0)', updatedAt: '2026-11-14T00:00:00.000Z', revision: 'apple-v1' },
  annotations: [{ id: 'mark1', type: 'highlight', cfi: 'epubcfi(/6/2!/4/2:0)', text: 'A thought.', note: '', color: 'yellow' }],
  ...overrides,
});
const pos = (overrides = {}) => ({
  cfi: 'epubcfi(/6/2!/4/4:0)', clientId: 'reader-a', sequence: 1, baseRevision: 0, appleRevision: 'apple-v1', ...overrides,
});
async function push(credential, books = [book()], sequence = 1) {
  return call('/api/companion/snapshot', { bearer: credential, originHeader: null, body: { sequence, books } });
}

before(async () => {
  database = new PGlite();
  pool = postgresPool(database);
  auth = createAuth({ origin, secret: randomBytes(32).toString('hex') }, pool, { sendEmail: async (message) => { emails.push(message); } });
  const migration = await getMigrations(auth.options);
  await migration.runMigrations();
  await database.exec(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  handle = createHandler({ auth, store: new PostgresStore(pool, { now: () => new Date(time) }), origin });
});
beforeEach(async () => {
  time = Date.parse('2026-11-14T00:00:00.000Z');
  emails.length = 0;
  accounts.clear();
  await database.exec('TRUNCATE TABLE "user", "verification", "rateLimit", books_device_pairings, books_pairing_limits CASCADE');
});
after(async () => { await database?.close(); });

test('unconfigured cloud stays closed and unauthenticated requests reveal no library', async () => {
  // This test has no production configuration and never creates a fallback library.
  const response = await createCloudHandler({})(request('/api/library'));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'CLOUD_NOT_CONFIGURED');
  for (const path of ['/api/session', '/api/library', '/api/books/BOOK1', '/api/devices']) {
    assert.equal((await call(path)).status, 401);
  }
  assert.equal((await call('/api/devices/pairing', { body: {} })).status, 401);
  assert.equal((await call('/api/companion/positions')).status, 401);
});

test('real Better Auth email link creates a secure session and is single-use', async () => {
  const user = await login();
  assert.equal(user.session.user.email, 'alice@example.test');
  const stored = await pool.query('SELECT * FROM "verification"');
  assert.equal(stored.rows.length, 0);
  const again = await handle(new Request(user.url, { headers: { 'x-books-client-ip': '203.0.113.7' } }));
  assert.equal(again.status, 302);
  assert.match(again.headers.get('location'), /INVALID_TOKEN/);
  assert.ok(!again.headers.getSetCookie().some((cookie) => cookie.includes('session_token=')));
  const logout = await call('/api/auth/sign-out', { cookie: user.cookie, body: {} });
  assert.equal(logout.status, 200);
  assert.equal((await call('/api/session', { cookie: user.cookie })).status, 401);
});

test('active sessions renew the persistent browser cookie on private routes and route errors', async () => {
  const user = await login();
  for (const [path, status] of [['/api/session', 200], ['/api/library', 200], ['/api/books/MISSING', 404]]) {
    // Make the real session eligible for Better Auth's daily refresh without waiting.
    await pool.query('UPDATE "session" SET "expiresAt"=$1 WHERE "userId"=$2', [new Date(Date.now() + 29 * 86_400_000 - 5000), user.session.user.id]);
    const result = await call(path, { cookie: user.cookie });
    assert.equal(result.status, status);
    const renewed = result.response.headers.getSetCookie().find((value) => value.includes('session_token='));
    assert.ok(renewed, `${path} should deliver the renewed cookie to the browser`);
    assert.match(renewed, /; Max-Age=2592000(?:;|$)/i);
    assert.match(renewed, /; Secure/i); assert.match(renewed, /; HttpOnly/i); assert.match(renewed, /; SameSite=Lax/i);
    assert.equal(result.response.headers.get('cache-control'), 'private, no-store');
    const stored = (await pool.query('SELECT "expiresAt" FROM "session" WHERE "userId"=$1', [user.session.user.id])).rows[0];
    assert.ok(new Date(stored.expiresAt).getTime() > Date.now() + 29.9 * 86_400_000);
  }
  const current = await call('/api/session', { cookie: user.cookie });
  assert.equal(current.status, 200);
  assert.ok(!current.response.headers.getSetCookie().some((value) => value.includes('session_token=')));
});

test('expired sessions clear the browser cookie while keeping the library private', async () => {
  const user = await login();
  await pool.query('UPDATE "session" SET "expiresAt"=$1 WHERE "userId"=$2', [new Date(Date.now() - 1000), user.session.user.id]);
  const result = await call('/api/library', { cookie: user.cookie });
  assert.equal(result.status, 401);
  const cleared = result.response.headers.getSetCookie().find((value) => value.includes('session_token='));
  assert.ok(cleared, 'The browser should receive the expired session cookie');
  assert.match(cleared, /; Max-Age=0(?:;|$)/i);
  assert.equal(result.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(result.body.books, undefined);
});

test('six-digit Mac pairing requires phone claim and matching Mac confirmation; secrets stay hashed', async () => {
  const alice = await login();
  const created = await startPairing('Alice Mac');
  assert.equal(created.status, 200);
  assert.match(created.body.code, /^\d{6}$/);
  assert.match(created.body.secret, /^pair_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.body.interval, 3);
  assert.equal(Date.parse(created.body.expiresAt), time + 300_000);
  const storedPairing = (await pool.query('SELECT * FROM books_device_pairings')).rows[0];
  assert.equal(storedPairing.secret_hash.length, 64); assert.equal(storedPairing.code_hash.length, 64);
  assert.ok(!JSON.stringify(storedPairing).includes(created.body.secret));
  assert.notEqual(storedPairing.code_hash, created.body.code);
  assert.equal(storedPairing.owner_id, null);
  const pending = await pollPairing(created.body.secret);
  assert.deepEqual(pending.body, { status: 'pending', expiresAt: created.body.expiresAt });
  assert.equal((await completePairing(created.body.secret, alice.session.user.id)).status, 409);
  const claimed = await claimPairing(alice.cookie, created.body.code);
  assert.deepEqual(claimed.body, { name: 'Alice Mac', deviceId: storedPairing.device_id,
    expiresAt: created.body.expiresAt, status: 'awaiting_mac' });
  assert.equal((await call('/api/devices', { cookie: alice.cookie })).body.devices.length, 0);
  assert.equal((await pollPairing(created.body.secret)).status, 429);
  time += 3000;
  const ready = await pollPairing(created.body.secret);
  assert.deepEqual(ready.body, { status: 'claimed', expiresAt: created.body.expiresAt,
    account: { id: alice.session.user.id, email: alice.session.user.email } });
  assert.equal((await completePairing(created.body.secret, 'different-account')).status, 409);
  const attempts = await Promise.all([completePairing(created.body.secret, alice.session.user.id), completePairing(created.body.secret, alice.session.user.id)]);
  assert.deepEqual(attempts.map((result) => result.status).sort(), [200, 401]);
  const linked = attempts.find((result) => result.status === 200).body;
  assert.equal(linked.device.id, claimed.body.deviceId);
  assert.match(linked.credential, /^device_[A-Za-z0-9_-]{43}$/);
  assert.equal((await pollPairing(created.body.secret)).status, 401);
  assert.equal((await claimPairing(alice.cookie, created.body.code)).status, 400);
  const devices = (await call('/api/devices', { cookie: alice.cookie })).body.devices;
  assert.equal(devices.length, 1);
  assert.ok(!JSON.stringify(devices).includes(linked.credential));
  const stored = (await pool.query('SELECT * FROM books_devices')).rows[0];
  assert.equal(stored.owner_id, alice.session.user.id);
  assert.equal(stored.credential_hash.length, 64);
  assert.ok(!JSON.stringify(stored).includes(linked.credential));
});

test('pairing expires after five minutes without changing existing devices', async () => {
  const alice = await login(), linked = await pair(alice.cookie);
  const stale = await startPairing('Expired Mac');
  time += 300_000;
  assert.equal((await claimPairing(alice.cookie, stale.body.code)).status, 400);
  assert.equal((await pollPairing(stale.body.secret)).status, 401);
  assert.equal((await completePairing(stale.body.secret, alice.session.user.id)).status, 401);
  assert.equal((await push(linked.credential)).status, 200);
  const claimed = await startPairing('Too late to confirm');
  assert.equal((await claimPairing(alice.cookie, claimed.body.code)).status, 200);
  time += 300_000;
  assert.equal((await completePairing(claimed.body.secret, alice.session.user.id)).status, 401);
  assert.equal((await push(linked.credential, [book()], 2)).status, 200);
});

test('completion rechecks expiry after waiting for the account lock', async () => {
  const alice = await login(), linked = await pair(alice.cookie);
  const created = await startPairing('Delayed confirmation');
  assert.equal((await claimPairing(alice.cookie, created.body.code)).status, 200);
  const delayedPool = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, parameters) {
          const result = await client.query(sql, parameters);
          if (sql === 'SELECT id FROM "user" WHERE id=$1 FOR UPDATE') time += 300_000;
          return result;
        },
        release: () => client.release(),
      };
    },
  };
  const store = new PostgresStore(delayedPool, { now: () => new Date(time) });
  await assert.rejects(store.completePairing(created.body.secret, alice.session.user.id, true), (error) => error.status === 401);
  assert.equal((await push(linked.credential)).status, 200);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM books_devices')).rows[0].count, 1);
});

test('a code can be claimed once and rejecting the shown account cannot replace a linked Mac', async () => {
  const alice = await login(), bob = await login('bob@example.test');
  const linked = await pair(alice.cookie);
  const created = await startPairing('Unconfirmed Mac');
  const attempts = await Promise.all([claimPairing(alice.cookie, created.body.code), claimPairing(bob.cookie, created.body.code)]);
  assert.deepEqual(attempts.map((result) => result.status).sort(), [200, 400]);
  const claimed = await pollPairing(created.body.secret);
  const owner = attempts[0].status === 200 ? alice : bob;
  assert.equal(claimed.body.account.id, owner.session.user.id);
  assert.deepEqual((await completePairing(created.body.secret, owner.session.user.id, false)).body, { ok: true });
  assert.equal((await completePairing(created.body.secret, owner.session.user.id)).status, 401);
  assert.equal((await push(linked.credential)).status, 200);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM books_devices')).rows[0].count, 1);
});

test('pairing routes enforce origins, account binding, strict payloads, and secret-only polling', async () => {
  const alice = await login();
  const created = await startPairing();
  for (const path of ['/api/devices/pairing/start', '/api/devices/pairing/poll', '/api/devices/pairing/complete']) {
    assert.equal((await call(path, { body: {} })).status, 403);
    assert.equal((await call(path, { originHeader: null, method: 'GET' })).status, 405);
  }
  for (const body of [{ code: 123456 }, { code: '12345' }, { code: '1234567' }, { code: '12 345' }, { code: created.body.code, ownerId: alice.session.user.id }]) {
    assert.equal((await call('/api/devices/pairing', { cookie: alice.cookie, body })).status, 400);
  }
  assert.equal((await claimPairing(alice.cookie, created.body.code, { originHeader: null })).status, 403);
  assert.equal((await claimPairing(alice.cookie, created.body.code, { accountHeader: 'another-account' })).status, 401);
  assert.equal((await pollPairing(created.body.code)).status, 400);
  assert.equal((await pollPairing('pair_' + 'x'.repeat(43))).status, 401);
  assert.equal((await completePairing(created.body.secret, alice.session.user.id, 'yes')).status, 400);
  assert.equal((await startPairing('   ')).status, 400);
  assert.equal((await startPairing('Mac', { body: { name: 'Mac', credential: 'secret' } })).status, 400);
  assert.equal((await call('/api/devices/claim', { cookie: alice.cookie, body: { token: created.body.secret, name: 'Old route' } })).status, 404);
});

test('pairing start limits are shared and concurrent requests cannot exceed the IP quota', async () => {
  const results = await Promise.all(Array.from({ length: 11 }, (_, index) => startPairing(`Mac ${index}`)));
  assert.equal(results.filter((result) => result.status === 200).length, 10);
  assert.equal(results.filter((result) => result.status === 429).length, 1);
  assert.equal((await startPairing('Still limited')).status, 429);
  assert.equal((await startPairing('Different network', { ip: '203.0.113.8' })).status, 200);
  time += 600_000;
  assert.equal((await startPairing('After expiry')).status, 200);
});

test('failed code claims count toward account limits and recover after the window', async () => {
  const alice = await login();
  const results = await Promise.all(Array.from({ length: 6 }, () => claimPairing(alice.cookie, '000000')));
  assert.equal(results.filter((result) => result.status === 400).length, 5);
  assert.equal(results.filter((result) => result.status === 429).length, 1);
  assert.equal((await claimPairing(alice.cookie, '000000', { ip: '203.0.113.8' })).status, 429);
  time += 300_000;
  assert.equal((await claimPairing(alice.cookie, '000000')).status, 400);
});

test('claim IP limits apply across signed-in accounts', async () => {
  const users = [];
  for (let index = 0; index < 5; index++) users.push(await login(`person${index}@example.test`, `203.0.113.${index + 20}`));
  for (const user of users.slice(0, 4)) {
    for (let index = 0; index < 5; index++) assert.equal((await claimPairing(user.cookie, '000000')).status, 400);
  }
  assert.equal((await claimPairing(users[4].cookie, '000000')).status, 429);
  assert.equal((await claimPairing(users[4].cookie, '000000', { ip: '203.0.113.99' })).status, 400);
});

test('code collisions retry without replacing an active pairing and leading zeroes survive', async () => {
  const codes = ['000123', '000123', '456789'];
  const store = new PostgresStore(pool, { now: () => new Date(time), pairingCode: () => codes.shift() });
  const results = await Promise.all([store.startPairing('First', '203.0.113.1'), store.startPairing('Second', '203.0.113.1')]);
  assert.deepEqual(results.map((result) => result.code), ['000123', '456789']);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM books_device_pairings')).rows[0].count, 2);
  const alice = await login();
  assert.equal((await claimPairing(alice.cookie, '000123')).body.name, 'First');
  assert.equal((await claimPairing(alice.cookie, '456789')).body.name, 'Second');
  const exhausted = new PostgresStore(pool, { now: () => new Date(time), pairingCode: () => '000123' });
  await assert.rejects(exhausted.startPairing('Collision', '203.0.113.1'), (error) => error.status === 503);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM books_device_pairings')).rows[0].count, 2);
});

test('two accounts cannot read, change, revoke, or pull each other’s books and devices', async () => {
  const alice = await login(); const bob = await login('bob@example.test');
  const a = await pair(alice.cookie, 'Alice Mac'); const b = await pair(bob.cookie, 'Bob Mac');
  assert.equal((await push(a.credential)).status, 200);
  assert.equal((await call('/api/books/BOOK1', { cookie: bob.cookie })).status, 404);
  assert.deepEqual((await call('/api/library', { cookie: bob.cookie })).body.books, []);
  assert.equal((await call('/api/books/BOOK1/position', { cookie: bob.cookie, body: pos() })).status, 404);
  assert.equal((await call(`/api/devices/${a.device.id}/revoke`, { cookie: bob.cookie, body: {} })).status, 404);
  assert.equal((await call('/api/books/BOOK1/position', { cookie: alice.cookie, body: pos() })).status, 200);
  assert.deepEqual((await call('/api/companion/positions', { bearer: b.credential })).body.positions, []);
  assert.equal((await push(b.credential, [book({ title: 'Bob version' })])).status, 200);
  assert.equal((await call('/api/books/BOOK1', { cookie: alice.cookie })).body.title, 'Private book');
  assert.equal((await call('/api/books/BOOK1', { cookie: bob.cookie })).body.title, 'Bob version');
  const pulled = (await call('/api/companion/positions', { bearer: a.credential })).body.positions;
  assert.equal(pulled.length, 1); assert.equal(pulled[0].syncState, 'pending');
  assert.equal((await call(`/api/devices/${a.device.id}/revoke`, { cookie: alice.cookie, body: {} })).status, 200);
  assert.equal((await push(a.credential)).status, 401);
  assert.equal((await call('/api/companion/positions', { bearer: a.credential })).status, 401);
});

test('metadata import rejects book bytes and file paths; no EPUB or cover route exists', async () => {
  const alice = await login(); const linked = await pair(alice.cookie);
  for (const field of ['epub', 'epubUrl', 'path', 'coverUrl', 'ownerId']) {
    assert.equal((await push(linked.credential, [book({ [field]: 'private data' })])).status, 400);
  }
  assert.equal((await push(linked.credential)).status, 200);
  const result = (await call('/api/books/BOOK1', { cookie: alice.cookie })).body;
  assert.equal(result.readable, false); assert.equal(result.epubUrl, null); assert.equal(result.coverUrl, null);
  assert.equal(result.annotations[0].text, 'A thought.');
  assert.equal((await call('/api/books/BOOK1/epub', { cookie: alice.cookie })).status, 404);
  assert.equal((await call('/api/books/BOOK1/cover', { cookie: alice.cookie })).status, 404);
  assert.equal((await push(linked.credential, [book({ title: 'x'.repeat(1_048_576) })])).status, 413);
  for (const href of [123, {}, 'file:///Users/private/book.epub', 'https://example.test/content', '/local/path']) {
    assert.equal((await call('/api/books/BOOK1/position', { cookie: alice.cookie, body: pos({ href }) })).status, 400);
  }
});

test('web saves win over Apple changes while competing readers and delayed saves stay protected', async () => {
  const alice = await login(); const linked = await pair(alice.cookie); await push(linked.credential);
  const save = (body) => call('/api/books/BOOK1/position', { cookie: alice.cookie, body });
  assert.equal((await save(pos())).body.position.revision, 1);
  assert.equal((await save(pos({ sequence: 2, cfi: 'epubcfi(/6/2!/4/6:0)' }))).body.position.revision, 2);
  const stale = await save(pos());
  assert.equal(stale.status, 200); assert.equal(stale.body.ignored, true); assert.equal(stale.body.position.revision, 2);
  assert.equal((await save(pos({ clientId: 'reader-b', baseRevision: 1 }))).status, 409);
  assert.equal((await save(pos({ clientId: 'reader-b', baseRevision: 2 }))).body.position.revision, 3);
  await push(linked.credential, [book({ applePosition: { cfi: 'epubcfi(/6/4!/4/2:0)', updatedAt: '2026-11-14T01:00:00Z', revision: 'apple-v2' } })], 2);
  const changed = await save(pos({ clientId: 'reader-b', sequence: 2, baseRevision: 3 }));
  assert.equal(changed.status, 200); assert.equal(changed.body.syncState, 'pending');
  assert.equal(changed.body.position.appleRevision, 'apple-v2');
  assert.equal(changed.body.position.revision, 4);
  assert.equal((await save(pos({ clientId: 'reader-a', sequence: 3, baseRevision: 3 }))).status, 409);
});

const applied = (overrides = {}) => ({
  revision: 1, cfi: pos().cfi,
  applePosition: { cfi: pos().cfi, updatedAt: '2026-11-14T00:01:00.000Z', revision: 'apple-applied' },
  ...overrides,
});
const acknowledge = (credential, value = applied(), bookId = 'BOOK1') => call(`/api/companion/positions/${bookId}/applied`, {
  bearer: credential, originHeader: null, body: value,
});

test('pending web position stays authoritative until exact native read-back acknowledgement', async () => {
  const alice = await login(); const linked = await pair(alice.cookie); await push(linked.credential);
  await call('/api/books/BOOK1/position', { cookie: alice.cookie, body: pos({ percentage: .4 }) });
  const read = () => call('/api/books/BOOK1', { cookie: alice.cookie });
  const pending = () => call('/api/companion/positions', { bearer: linked.credential });
  assert.equal((await pending()).body.positions.length, 1);
  assert.equal((await read()).body.syncState, 'pending');
  // A snapshot alone, even at the same CFI, never claims the native handoff ran.
  await push(linked.credential, [book({ applePosition: applied().applePosition })], 2);
  assert.equal((await read()).body.syncState, 'pending');
  assert.deepEqual((await read()).body.resume, { cfi: pos().cfi, source: 'web' });
  const ack = await acknowledge(linked.credential);
  assert.equal(ack.status, 200); assert.equal(ack.body.revision, 1);
  assert.deepEqual((await pending()).body.positions, []);
  const detail = (await read()).body;
  assert.equal(detail.syncState, 'synced'); assert.equal(detail.progress, .4);
  assert.deepEqual(detail.webPosition.applied.applePosition, applied().applePosition);
  assert.equal(detail.webPosition.applied.deviceId, linked.device.id);
  assert.equal((await acknowledge(linked.credential)).body.ignored, true);
});

test('new Apple reading resumes in web after acknowledgement, but older snapshots and new web saves cannot reverse precedence', async () => {
  const alice = await login(); const linked = await pair(alice.cookie); await push(linked.credential);
  const save = (body) => call('/api/books/BOOK1/position', { cookie: alice.cookie, body });
  const read = async () => (await call('/api/books/BOOK1', { cookie: alice.cookie })).body;
  await save(pos({ percentage: .4 }));
  await acknowledge(linked.credential);
  assert.equal((await read()).syncState, 'synced');
  assert.deepEqual((await read()).resume, { cfi: pos().cfi, source: 'web' });
  // The imported Apple snapshot is older than the native read-back in the ACK.
  await push(linked.credential, [book()], 2);
  assert.equal((await read()).syncState, 'synced');
  const newerApple = { cfi: 'epubcfi(/6/8!/4/2:0)', updatedAt: '2026-11-14T00:05:00.000Z', revision: 'apple-advanced' };
  await push(linked.credential, [book({ applePosition: newerApple, progress: .6 })], 3);
  assert.equal((await read()).syncState, 'apple');
  assert.deepEqual((await read()).resume, { cfi: newerApple.cfi, source: 'apple' });
  assert.equal((await read()).progress, .6);
  assert.deepEqual((await call('/api/companion/positions', { bearer: linked.credential })).body.positions, []);
  const next = await save(pos({ sequence: 2, cfi: 'epubcfi(/6/10!/4/2:0)' }));
  assert.equal(next.status, 200); assert.equal(next.body.position.applied, undefined);
  assert.equal(next.body.position.revision, 2); assert.equal((await read()).syncState, 'pending');
  assert.deepEqual((await read()).resume, { cfi: next.body.position.cfi, source: 'web' });
  assert.equal((await call('/api/companion/positions', { bearer: linked.credential })).body.positions.length, 1);
});

test('stale acknowledgement cannot clear a newer web revision even when its CFI matches', async () => {
  const alice = await login(); const linked = await pair(alice.cookie); await push(linked.credential);
  const save = (body) => call('/api/books/BOOK1/position', { cookie: alice.cookie, body });
  await save(pos());
  await save(pos({ sequence: 2 }));
  assert.equal((await acknowledge(linked.credential)).status, 409);
  assert.equal((await acknowledge(linked.credential, applied({ revision: 2 }))).status, 200);
  const later = await save(pos({ sequence: 3, cfi: 'epubcfi(/6/12!/4/2:0)' }));
  assert.equal(later.body.position.revision, 3);
  assert.equal((await acknowledge(linked.credential, applied({ revision: 3 }))).status, 409);
  const pending = (await call('/api/companion/positions', { bearer: linked.credential })).body.positions;
  assert.equal(pending.length, 1); assert.equal(pending[0].position.revision, 3);
  assert.equal(pending[0].position.applied, undefined);
});

test('native position acknowledgements are account- and source-Mac-scoped, including replacement and revocation', async () => {
  const alice = await login(); const bob = await login('bob@example.test');
  const first = await pair(alice.cookie); const other = await pair(bob.cookie);
  await push(first.credential);
  await call('/api/books/BOOK1/position', { cookie: alice.cookie, body: pos() });
  assert.equal((await acknowledge(other.credential)).status, 404);
  assert.equal((await call('/api/companion/positions/BOOK1/applied', { cookie: alice.cookie, body: applied() })).status, 403);
  assert.equal((await call('/api/companion/positions/BOOK1/applied', { cookie: alice.cookie, originHeader: null, body: applied() })).status, 401);
  const replacement = await pair(alice.cookie, 'Replacement Mac');
  assert.deepEqual((await call('/api/companion/positions', { bearer: replacement.credential })).body.positions, []);
  assert.equal((await acknowledge(replacement.credential)).status, 404);
  assert.equal((await acknowledge(first.credential)).status, 401);
  await push(replacement.credential);
  assert.equal((await call('/api/companion/positions', { bearer: replacement.credential })).body.positions.length, 1);
  assert.equal((await acknowledge(replacement.credential)).status, 200);
  await call(`/api/devices/${replacement.device.id}/revoke`, { cookie: alice.cookie, body: {} });
  assert.equal((await acknowledge(replacement.credential)).status, 401);
});

test('applied positions do not count as applied on a replacement Mac until it confirms the position', async () => {
  const alice = await login(); const first = await pair(alice.cookie); await push(first.credential);
  await call('/api/books/BOOK1/position', { cookie: alice.cookie, body: pos() });
  await acknowledge(first.credential);
  const replacement = await pair(alice.cookie, 'Replacement Mac'); await push(replacement.credential);
  assert.equal((await call('/api/books/BOOK1', { cookie: alice.cookie })).body.syncState, 'pending');
  assert.equal((await call('/api/companion/positions', { bearer: replacement.credential })).body.positions.length, 1);
  assert.equal((await acknowledge(replacement.credential)).status, 200);
  assert.equal((await call('/api/books/BOOK1', { cookie: alice.cookie })).body.webPosition.applied.deviceId, replacement.device.id);
});

test('a paired Mac may acknowledge Apple’s canonicalized range while retaining the exact requested target', async () => {
  const alice = await login(); const linked = await pair(alice.cookie); await push(linked.credential);
  const target = 'epubcfi(/6/2!/4/110/1:313)';
  await call('/api/books/BOOK1/position', { cookie: alice.cookie, body: pos({ cfi: target }) });
  const observed = { cfi: 'epubcfi(/6/2!/4/110/1,:0,:1)', updatedAt: '2026-11-14T00:01:00.000Z', revision: 'apple-canonical' };
  assert.equal((await acknowledge(linked.credential, applied({ cfi: observed.cfi, applePosition: observed }))).status, 409);
  const ack = await acknowledge(linked.credential, applied({ cfi: target, applePosition: observed }));
  assert.equal(ack.status, 200);
  const detail = (await call('/api/books/BOOK1', { cookie: alice.cookie })).body;
  assert.equal(detail.syncState, 'synced');
  assert.equal(detail.webPosition.cfi, target);
  assert.deepEqual(detail.webPosition.applied.applePosition, observed);
  assert.deepEqual((await call('/api/companion/positions', { bearer: linked.credential })).body.positions, []);
});

test('acknowledgements require valid native read-back metadata and reject unrelated data', async () => {
  const alice = await login(); const linked = await pair(alice.cookie); await push(linked.credential);
  await call('/api/books/BOOK1/position', { cookie: alice.cookie, body: pos() });
  for (const patch of [
    { revision: 0 }, { revision: 1.5 }, { revision: '1' }, { cfi: 'file:///private' },
    { applePosition: null }, { applePosition: { ...applied().applePosition, cfi: 'not-an-epub-position' } },
    { applePosition: { ...applied().applePosition, updatedAt: null } },
    { applePosition: { ...applied().applePosition, updatedAt: 'yesterday' } },
    { applePosition: { ...applied().applePosition, epub: 'bytes' } }, { ownerId: 'someone-else' },
  ]) assert.equal((await acknowledge(linked.credential, applied(patch))).status, 400, JSON.stringify(patch));
  assert.equal((await call('/api/books/BOOK1', { cookie: alice.cookie })).body.syncState, 'pending');
});

test('snapshot sequence rejects stale import without overwriting web progress or deleting omitted books', async () => {
  const alice = await login(); const linked = await pair(alice.cookie);
  await push(linked.credential, [book(), book({ id: 'BOOK2' })], 2);
  await call('/api/books/BOOK1/position', { cookie: alice.cookie, body: pos() });
  const stale = await push(linked.credential, [book({ title: 'Stale title' })], 1);
  assert.equal(stale.body.ignored, true);
  await push(linked.credential, [book({ title: 'New title' })], 3);
  const library = (await call('/api/library', { cookie: alice.cookie })).body;
  assert.equal(library.books.length, 2);
  const saved = (await call('/api/books/BOOK1', { cookie: alice.cookie })).body;
  assert.equal(saved.title, 'New title'); assert.equal(saved.webPosition.revision, 1);
});

test('browser writes require exact Origin and cannot forge ownership in position payload', async () => {
  const alice = await login(); const linked = await pair(alice.cookie); await push(linked.credential);
  for (const originHeader of [null, 'https://attacker.example']) {
    assert.equal((await call('/api/devices/pairing', { cookie: alice.cookie, body: {}, originHeader })).status, 403);
    assert.equal((await call('/api/auth/sign-out', { cookie: alice.cookie, body: {}, originHeader })).status, 403);
    assert.equal((await call('/api/books/BOOK1/position', { cookie: alice.cookie, body: pos(), originHeader })).status, 403);
  }
  assert.equal((await call('/api/books/BOOK1/position', { cookie: alice.cookie, body: pos({ ownerId: 'someone-else' }) })).status, 400);
  const invalid = await handle(new Request('https://attacker.example/api/library', { headers: { cookie: alice.cookie } }));
  assert.equal(invalid.status, 403);
});

test('an old reader tab cannot use a newly signed-in account cookie', async () => {
  const alice = await login(); const bob = await login('bob@example.test');
  const b = await pair(bob.cookie); await push(b.credential);
  const staleTab = { cookie: bob.cookie, accountHeader: alice.session.user.id };
  for (const path of ['/api/library', '/api/books/BOOK1', '/api/devices']) {
    const denied = await call(path, staleTab);
    assert.equal(denied.status, 401); assert.equal(denied.body.code, 'ACCOUNT_CHANGED');
  }
  assert.equal((await call('/api/books/BOOK1/position', { ...staleTab, body: pos() })).status, 401);
  assert.equal((await call('/api/devices/pairing', { ...staleTab, body: {} })).status, 401);
  assert.equal((await call('/api/library', { cookie: bob.cookie, accountHeader: null })).status, 401);
  assert.equal((await call('/api/session', staleTab)).body.user.id, bob.session.user.id);
  assert.equal((await call('/api/books/BOOK1', { cookie: bob.cookie })).body.webPosition, null);
});

test('linking a replacement Mac keeps the old writer until the Mac confirms its account', async () => {
  const alice = await login(); const first = await pair(alice.cookie, 'First Mac'); await push(first.credential);
  const replacement = await startPairing('Replacement Mac');
  const claimed = await claimPairing(alice.cookie, replacement.body.code);
  assert.equal(claimed.status, 200);
  assert.equal((await push(first.credential, [book()], 2)).status, 200);
  const finished = await completePairing(replacement.body.secret, alice.session.user.id);
  assert.equal(finished.status, 200);
  assert.equal((await push(first.credential, [book({ title: 'Old Mac' })], 3)).status, 401);
  assert.equal((await push(finished.body.credential, [book({ title: 'New Mac' })])).status, 200);
  const devices = (await call('/api/devices', { cookie: alice.cookie })).body.devices;
  assert.equal(devices.length, 2); assert.equal(devices.filter((device) => !device.revokedAt).length, 1);
  assert.equal((await call('/api/books/BOOK1', { cookie: alice.cookie })).body.title, 'New Mac');
});

const connection = (type = 'offer', extraLines = []) => ({ type, sdp: [
  'v=0', 'o=- 123456789 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
  'a=group:BUNDLE 0', 'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
  'a=mid:0', 'a=ice-ufrag:abcdefghijkl', 'a=ice-pwd:abcdefghijklmnopqrstuvwxyz',
  `a=fingerprint:sha-256 ${Array(32).fill('AB').join(':')}`,
  `a=setup:${type === 'offer' ? 'actpass' : 'active'}`, 'a=sctp-port:5000', 'a=max-message-size:262144',
  'a=candidate:1234 1 udp 2122260223 12345678-abcd.local 54000 typ host generation 0 network-cost 10',
  'a=end-of-candidates', ...extraLines, '',
].join('\r\n') });
const receiveTransfers = (credential, covers = false) => call('/api/companion/transfers', {
  bearer: credential, originHeader: null, ...(covers ? { headers: { 'X-Books-Covers': '1' } } : {}),
});
const startTransfer = (cookie, body = { bookId: 'BOOK1', offer: connection() }, options = {}) => call('/api/transfers', { cookie, body, ...options });
const startCovers = (cookie, bookIds = ['BOOK1'], options = {}) => startTransfer(cookie,
  { kind: 'covers', bookId: bookIds[0], bookIds, offer: connection() }, options);
const answerTransfer = (credential, id, body = { answer: connection('answer') }) => call(`/api/companion/transfers/${id}`, { bearer: credential, originHeader: null, body });

async function transferFixture() {
  const alice = await login();
  const mac = await pair(alice.cookie);
  await push(mac.credential);
  await receiveTransfers(mac.credential);
  return { alice, mac };
}

test('direct-transfer signaling is account/device scoped and never exposes the offer to another reader', async () => {
  const { alice, mac } = await transferFixture();
  const bob = await login('bob@example.test'), otherMac = await pair(bob.cookie);
  assert.equal((await call('/api/library', { cookie: alice.cookie })).body.transferReady, true);
  assert.equal((await call('/api/devices', { cookie: alice.cookie })).body.devices[0].transferReady, true);
  const created = await startTransfer(alice.cookie);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.id;
  assert.equal((await startTransfer(bob.cookie)).status, 404);
  assert.equal((await call(`/api/transfers/${id}`)).status, 401);
  assert.equal((await call(`/api/transfers/${id}`, { cookie: bob.cookie })).status, 404);
  assert.equal((await call(`/api/transfers/${id}`, { cookie: bob.cookie, accountHeader: alice.session.user.id })).status, 401);
  assert.deepEqual((await receiveTransfers(otherMac.credential)).body.transfers, []);
  assert.equal((await answerTransfer(otherMac.credential, id)).status, 404);
  assert.equal((await call(`/api/transfers/${id}/close`, { cookie: bob.cookie, body: {} })).status, 200);
  const pending = (await receiveTransfers(mac.credential)).body.transfers;
  assert.equal(pending.length, 1); assert.equal(pending[0].id, id); assert.equal(pending[0].bookId, 'BOOK1');
  assert.deepEqual(pending[0].offer, connection());
  const waiting = (await call(`/api/transfers/${id}`, { cookie: alice.cookie })).body;
  assert.equal(waiting.status, 'waiting'); assert.equal(waiting.answer, null); assert.equal(waiting.offer, undefined);
  assert.equal((await answerTransfer(mac.credential, id)).status, 200);
  const answered = await call(`/api/transfers/${id}`, { cookie: alice.cookie });
  assert.equal(answered.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(answered.body.status, 'answered'); assert.deepEqual(answered.body.answer, connection('answer'));
  assert.deepEqual((await receiveTransfers(mac.credential)).body.transfers, []);
  assert.equal((await answerTransfer(mac.credential, id)).status, 404);
  assert.equal((await call(`/api/transfers/${id}/close`, { cookie: alice.cookie, body: {} })).status, 200);
  assert.equal((await call(`/api/transfers/${id}`, { cookie: alice.cookie })).status, 404);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM books_transfers')).rows[0].count, 0);
});

test('transfers need a fresh sender heartbeat and downloaded EPUB, and enforce bounded expiry and concurrency', async () => {
  const alice = await login(), mac = await pair(alice.cookie);
  await push(mac.credential, [book(), book({ id: 'NOT_DOWNLOADED', availableOnMac: false })]);
  const asleep = await startTransfer(alice.cookie);
  assert.equal(asleep.status, 503); assert.match(asleep.body.error, /Start transfers on your Mac/);
  await receiveTransfers(mac.credential);
  assert.equal((await startTransfer(alice.cookie, { bookId: 'NOT_DOWNLOADED', offer: connection() })).status, 409);
  const created = await Promise.all([startTransfer(alice.cookie), startTransfer(alice.cookie), startTransfer(alice.cookie), startTransfer(alice.cookie)]);
  assert.deepEqual(created.map((x) => x.status).sort(), [200, 200, 200, 429]);
  const id = created.find((x) => x.status === 200).body.id;
  time += 30_001;
  assert.equal((await call('/api/library', { cookie: alice.cookie })).body.transferReady, false);
  assert.equal((await startTransfer(alice.cookie)).status, 503);
  time += 150_000;
  assert.equal((await call(`/api/transfers/${id}`, { cookie: alice.cookie })).status, 404);
  assert.equal((await answerTransfer(mac.credential, id)).status, 404);
  assert.deepEqual((await receiveTransfers(mac.credential)).body.transfers, []);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM books_transfers')).rows[0].count, 0);
  assert.equal((await startTransfer(alice.cookie)).status, 200);
});

test('revoking or replacing a Mac invalidates its transfer offers, answers, and credentials', async () => {
  const { alice, mac } = await transferFixture();
  const first = await startTransfer(alice.cookie);
  await answerTransfer(mac.credential, first.body.id);
  await call(`/api/devices/${mac.device.id}/revoke`, { cookie: alice.cookie, body: {} });
  assert.equal((await receiveTransfers(mac.credential)).status, 401);
  assert.equal((await answerTransfer(mac.credential, first.body.id)).status, 401);
  assert.equal((await call(`/api/transfers/${first.body.id}`, { cookie: alice.cookie })).status, 404);
  assert.equal((await startTransfer(alice.cookie)).status, 503);
  const second = await pair(alice.cookie); await push(second.credential); await receiveTransfers(second.credential);
  const pending = await startTransfer(alice.cookie);
  const replacement = await pair(alice.cookie);
  assert.equal((await call(`/api/transfers/${pending.body.id}`, { cookie: alice.cookie })).status, 404);
  assert.deepEqual((await receiveTransfers(replacement.credential)).body.transfers, []);
  assert.equal((await answerTransfer(replacement.credential, pending.body.id)).status, 404);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM books_transfers')).rows[0].count, 0);
});

test('transfer APIs reject files, free-form SDP, media tracks, wrong origins, and mismatched accounts', async () => {
  const { alice, mac } = await transferFixture();
  for (const originHeader of [null, 'https://attacker.example']) assert.equal((await startTransfer(alice.cookie, undefined, { originHeader })).status, 403);
  assert.equal((await startTransfer(alice.cookie, undefined, { accountHeader: 'someone-else' })).status, 401);
  const malicious = [
    { bookId: 'BOOK1', offer: connection(), epub: 'base64-file' },
    { bookId: '../private.epub', offer: connection() },
    { bookId: 'BOOK1', offer: { ...connection(), epub: 'base64-file' } },
    { bookId: 'BOOK1', offer: { ...connection(), type: 'answer' } },
    { bookId: 'BOOK1', offer: { type: 'offer', sdp: 'PK\u0003\u0004file' } },
    { bookId: 'BOOK1', offer: { type: 'offer', sdp: 'x'.repeat(32769) } },
    { bookId: 'BOOK1', offer: connection('offer', ['a=x-book-file:encoded-file']) },
    { bookId: 'BOOK1', offer: connection('offer', ['m=audio 9 UDP/TLS/RTP/SAVPF 111']) },
    { bookId: 'BOOK1', offer: { ...connection(), sdp: connection().sdp.replace('s=-', 's=encoded-file') } },
  ];
  for (const body of malicious) assert.equal((await startTransfer(alice.cookie, body)).status, 400);
  const created = await startTransfer(alice.cookie), id = created.body.id;
  for (const body of [{ answer: connection('answer'), error: 'TRANSFER_FAILED' }, { error: 'private file data' }, { answer: connection('offer') }, { error: 'TRANSFER_FAILED', epub: 'bytes' }]) {
    assert.equal((await answerTransfer(mac.credential, id, body)).status, 400);
  }
  assert.equal((await call(`/api/companion/transfers/${id}`, { bearer: mac.credential, body: { answer: connection('answer') } })).status, 403);
  assert.equal((await answerTransfer(mac.credential, id, { error: 'BOOK_TOO_LARGE' })).status, 200);
  const failed = (await call(`/api/transfers/${id}`, { cookie: alice.cookie })).body;
  assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'BOOK_TOO_LARGE'); assert.equal(failed.answer, null);
});

test('cover batches use capable companions and never reach an older EPUB-only sender', async () => {
  const { alice, mac } = await transferFixture();
  await push(mac.credential, [book(), book({ id: 'CLOUD_ONLY', availableOnMac: false })], 2);
  assert.equal((await call('/api/library', { cookie: alice.cookie })).body.coversReady, false);
  const unsupported = await startCovers(alice.cookie);
  assert.equal(unsupported.status, 409); assert.match(unsupported.body.error, /Update and restart/);
  const epub = await startTransfer(alice.cookie);
  assert.equal(epub.status, 200);
  assert.equal((await startTransfer(alice.cookie, { bookId: 'CLOUD_ONLY', offer: connection() })).status, 409);
  await receiveTransfers(mac.credential, true);
  assert.equal((await call('/api/library', { cookie: alice.cookie })).body.coversReady, true);
  const covers = await startCovers(alice.cookie, ['CLOUD_ONLY', 'BOOK1']);
  assert.equal(covers.status, 200, JSON.stringify(covers.body));
  const pending = (await receiveTransfers(mac.credential, true)).body.transfers;
  const coverOffer = pending.find((item) => item.id === covers.body.id);
  assert.deepEqual(coverOffer, { id: covers.body.id, bookId: 'CLOUD_ONLY', kind: 'covers',
    bookIds: ['CLOUD_ONLY', 'BOOK1'], offer: connection(), expiresAt: covers.body.expiresAt });
  const epubOffer = pending.find((item) => item.id === epub.body.id);
  assert.equal(epubOffer.kind, undefined); assert.equal(epubOffer.bookIds, undefined);
  assert.equal((await call(`/api/transfers/${epub.body.id}`, { cookie: alice.cookie })).body.kind, undefined);
  const progress = (await call(`/api/transfers/${covers.body.id}`, { cookie: alice.cookie })).body;
  assert.equal(progress.kind, 'covers'); assert.equal(progress.bookIds, undefined); assert.equal(progress.offer, undefined);
  const oldPending = (await receiveTransfers(mac.credential)).body.transfers;
  assert.deepEqual(oldPending.map((item) => item.id), [epub.body.id]);
  assert.equal((await call('/api/library', { cookie: alice.cookie })).body.coversReady, false);
  assert.equal((await startCovers(alice.cookie)).status, 409);
  for (const flag of ['true', '01']) {
    await call('/api/companion/transfers', { bearer: mac.credential, originHeader: null, headers: { 'X-Books-Covers': flag } });
    assert.equal((await call('/api/library', { cookie: alice.cookie })).body.coversReady, false);
  }
  await receiveTransfers(mac.credential, true);
  assert.equal((await answerTransfer(mac.credential, covers.body.id)).status, 200);
  const answered = await call(`/api/transfers/${covers.body.id}`, { cookie: alice.cookie });
  assert.equal(answered.body.kind, 'covers'); assert.equal(answered.body.status, 'answered');
  assert.deepEqual(answered.body.answer, connection('answer'));
  const stored = (await pool.query('SELECT kind,book_ids,offer,answer FROM books_transfers WHERE id=$1', [covers.body.id])).rows[0];
  assert.deepEqual(stored, { kind: 'covers', book_ids: ['CLOUD_ONLY', 'BOOK1'], offer: connection(), answer: connection('answer') });
});

test('legacy transfer inserts default to EPUB and schema upgrades preserve existing offers', async () => {
  const { alice, mac } = await transferFixture();
  const expiresAt = new Date(time + 180_000);
  await pool.query(`INSERT INTO books_transfers (id,owner_id,book_id,device_id,offer,created_at,expires_at)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`, ['legacy-offer', alice.session.user.id, 'BOOK1', mac.device.id,
    JSON.stringify(connection()), new Date(time), expiresAt]);
  await database.exec(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stored = (await pool.query('SELECT kind,book_ids FROM books_transfers WHERE id=$1', ['legacy-offer'])).rows[0];
  assert.deepEqual(stored, { kind: 'epub', book_ids: null });
  assert.deepEqual((await receiveTransfers(mac.credential)).body.transfers,
    [{ id: 'legacy-offer', bookId: 'BOOK1', offer: connection(), expiresAt: expiresAt.toISOString() }]);
});

test('every cover ID must belong to the reader and the same active source Mac', async () => {
  const alice = await login(), oldMac = await pair(alice.cookie);
  await push(oldMac.credential, [book({ id: 'OLD_MAC' })]);
  const mac = await pair(alice.cookie);
  await push(mac.credential, [book()]); await receiveTransfers(mac.credential, true);
  const catalogue = (await call('/api/library', { cookie: alice.cookie })).body;
  assert.equal(catalogue.coversReady, true);
  assert.equal(catalogue.coverDeviceId, mac.device.id);
  assert.equal(catalogue.books.find((item) => item.id === 'OLD_MAC').sourceDeviceId, oldMac.device.id);
  assert.deepEqual(catalogue.books.filter((item) => item.sourceDeviceId === catalogue.coverDeviceId).map((item) => item.id), ['BOOK1']);
  const bob = await login('bob@example.test'), otherMac = await pair(bob.cookie);
  await push(otherMac.credential, [book({ id: 'BOB_PRIVATE' })]); await receiveTransfers(otherMac.credential, true);
  assert.equal((await startCovers(alice.cookie, ['BOOK1', 'BOB_PRIVATE'])).status, 404);
  assert.equal((await startCovers(alice.cookie, ['BOOK1', 'MISSING'])).status, 404);
  assert.equal((await startCovers(alice.cookie, ['BOOK1', 'OLD_MAC'])).status, 409);
  assert.equal((await startCovers(alice.cookie, ['OLD_MAC'])).status, 503);
  assert.equal((await startCovers(alice.cookie, ['BOOK1'], { accountHeader: bob.session.user.id })).status, 401);
  assert.equal((await startCovers(alice.cookie, ['BOOK1'], { originHeader: null })).status, 403);
  const created = await startCovers(alice.cookie);
  assert.equal(created.status, 200);
  assert.deepEqual((await receiveTransfers(otherMac.credential, true)).body.transfers, []);
  assert.equal((await call(`/api/transfers/${created.body.id}`, { cookie: bob.cookie })).status, 404);
  assert.equal((await answerTransfer(otherMac.credential, created.body.id)).status, 404);
});

test('cover batches reject malformed lists, unknown kinds, image bytes, and unsafe descriptions', async () => {
  const { alice, mac } = await transferFixture();
  await receiveTransfers(mac.credential, true);
  const value = { kind: 'covers', bookId: 'BOOK1', bookIds: ['BOOK1'], offer: connection() };
  const malformed = [
    { ...value, kind: 'images' }, { ...value, kind: null }, { ...value, bookIds: null },
    { ...value, bookIds: [] }, { ...value, bookIds: ['BOOK1', 'BOOK1'] },
    { ...value, bookIds: ['OTHER', 'BOOK1'] }, { ...value, bookIds: ['BOOK1', 2] },
    { ...value, bookIds: ['BOOK1', '../private.jpg'] },
    { ...value, bookIds: Array.from({ length: 201 }, (_, index) => index ? `BOOK${index + 1}` : 'BOOK1') },
    { ...value, kind: 'epub' }, { bookId: 'BOOK1', bookIds: ['BOOK1'], offer: connection() },
    { ...value, covers: ['data:image/jpeg;base64,private-image'] }, { ...value, imageBytes: 'private-image' },
    { ...value, offer: connection('offer', ['a=x-cover:data:image/jpeg;base64,private-image']) },
  ];
  for (const body of malformed) assert.equal((await startTransfer(alice.cookie, body)).status, 400);
  const created = await startCovers(alice.cookie);
  assert.equal(created.status, 200);
  assert.equal((await answerTransfer(mac.credential, created.body.id, { answer: connection('answer'), cover: 'private-image' })).status, 400);
  assert.equal((await call('/api/books/BOOK1/cover', { cookie: alice.cookie })).status, 404);
  assert.ok(!JSON.stringify((await pool.query('SELECT * FROM books_transfers')).rows).includes('private-image'));
});

test('a cover batch accepts 200 bounded IDs including the largest valid identifiers', async () => {
  const { alice, mac } = await transferFixture();
  const ids = Array.from({ length: 200 }, (_, index) => `BOOK${index}`.padEnd(200, 'x'));
  await push(mac.credential, ids.map((id) => book({ id, availableOnMac: false })), 2);
  await receiveTransfers(mac.credential, true);
  const created = await startCovers(alice.cookie, ids);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual((await receiveTransfers(mac.credential, true)).body.transfers[0].bookIds, ids);
});

test('cover offers share transfer quotas and become unavailable after expiry or revocation', async () => {
  const { alice, mac } = await transferFixture();
  await receiveTransfers(mac.credential, true);
  const created = await Promise.all([startCovers(alice.cookie), startTransfer(alice.cookie), startCovers(alice.cookie)]);
  assert.ok(created.every((result) => result.status === 200));
  assert.equal((await startCovers(alice.cookie)).status, 429);
  time += 30_001;
  const staleLibrary = (await call('/api/library', { cookie: alice.cookie })).body;
  assert.equal(staleLibrary.coversReady, false);
  assert.equal(staleLibrary.coverDeviceId, null);
  assert.equal((await startCovers(alice.cookie)).status, 503);
  time += 150_000;
  for (const result of created) {
    assert.equal((await call(`/api/transfers/${result.body.id}`, { cookie: alice.cookie })).status, 404);
    assert.equal((await answerTransfer(mac.credential, result.body.id)).status, 404);
  }
  assert.deepEqual((await receiveTransfers(mac.credential, true)).body.transfers, []);
  const active = await startCovers(alice.cookie);
  assert.equal(active.status, 200);
  await call(`/api/devices/${mac.device.id}/revoke`, { cookie: alice.cookie, body: {} });
  assert.equal((await call(`/api/transfers/${active.body.id}`, { cookie: alice.cookie })).status, 404);
  assert.equal((await receiveTransfers(mac.credential, true)).status, 401);
  assert.equal((await startCovers(alice.cookie)).status, 503);
  assert.equal((await call('/api/library', { cookie: alice.cookie })).body.coversReady, false);
});
