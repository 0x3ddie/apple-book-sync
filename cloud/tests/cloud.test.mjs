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

function request(path, { cookie, bearer, body, originHeader = origin, accountHeader, method, headers = {} } = {}) {
  method ??= body === undefined ? 'GET' : 'POST';
  const builtHeaders = new Headers(headers);
  builtHeaders.set('x-books-client-ip', '203.0.113.7');
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

async function login(email = 'alice@example.test') {
  const sent = await call('/api/auth/sign-in/magic-link', { body: { email, callbackURL: '/' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const message = emails.at(-1);
  assert.equal(message.email, email);
  const result = await handle(new Request(message.url, { headers: { 'x-books-client-ip': '203.0.113.7' } }));
  assert.equal(result.status, 302);
  const sessionCookie = result.headers.getSetCookie().find((value) => value.includes('session_token='));
  assert.match(sessionCookie, /; Secure/i); assert.match(sessionCookie, /; HttpOnly/i); assert.match(sessionCookie, /; SameSite=Lax/i);
  const cookie = result.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  assert.ok(cookie.includes('session_token='));
  const session = (await call('/api/session', { cookie })).body;
  accounts.set(cookie, session.user.id);
  return { cookie, url: message.url, session };
}

async function pair(cookie, name = 'Test Mac') {
  const created = await call('/api/devices/pairing', { cookie, body: {} });
  assert.equal(created.status, 200);
  const claimed = await call('/api/devices/claim', { originHeader: null, body: { token: created.body.token, name } });
  assert.equal(claimed.status, 200);
  return { ...claimed.body, token: created.body.token };
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
  await database.exec('TRUNCATE TABLE "user", "verification", "rateLimit" CASCADE');
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

test('pairing binds the approving owner, expires, cannot replay, and credentials are hashed', async () => {
  const alice = await login();
  const stale = await call('/api/devices/pairing', { cookie: alice.cookie, body: {} });
  time += 600_001;
  assert.equal((await call('/api/devices/claim', { originHeader: null, body: { token: stale.body.token, name: 'Old' } })).status, 401);
  const linked = await pair(alice.cookie);
  assert.equal((await call('/api/devices/claim', { originHeader: null, body: { token: linked.token, name: 'Again' } })).status, 401);
  const devices = await call('/api/devices', { cookie: alice.cookie });
  assert.equal(devices.body.devices.length, 1);
  assert.ok(!JSON.stringify(devices.body).includes(linked.credential));
  const stored = (await pool.query('SELECT * FROM books_devices')).rows[0];
  assert.equal(stored.owner_id, alice.session.user.id);
  assert.equal(stored.credential_hash.length, 64);
  assert.ok(!JSON.stringify(stored).includes(linked.credential));
  const browserClaim = await call('/api/devices/claim', { body: { token: linked.token, name: 'Browser' } });
  assert.equal(browserClaim.status, 403);
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

test('position CAS rejects competing readers and changed Apple baseline; delayed saves are idempotent', async () => {
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
  assert.equal(changed.status, 409); assert.equal(changed.body.book.syncState, 'conflict');
  assert.equal((await save(pos({ clientId: 'reader-b', sequence: 2, baseRevision: 3, appleRevision: 'apple-v2' }))).status, 200);
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

test('linking a replacement Mac revokes the old writer and supersedes old unclaimed codes', async () => {
  const alice = await login(); const first = await pair(alice.cookie, 'First Mac'); await push(first.credential);
  const obsolete = await call('/api/devices/pairing', { cookie: alice.cookie, body: {} });
  const replacement = await pair(alice.cookie, 'Replacement Mac');
  assert.equal((await call('/api/devices/claim', { originHeader: null, body: { token: obsolete.body.token, name: 'Obsolete' } })).status, 401);
  assert.equal((await push(first.credential, [book({ title: 'Old Mac' })], 2)).status, 401);
  assert.equal((await push(replacement.credential, [book({ title: 'New Mac' })])).status, 200);
  const devices = (await call('/api/devices', { cookie: alice.cookie })).body.devices;
  assert.equal(devices.length, 2); assert.equal(devices.filter((device) => !device.revokedAt).length, 1);
  assert.equal((await call('/api/books/BOOK1', { cookie: alice.cookie })).body.title, 'New Mac');
});
