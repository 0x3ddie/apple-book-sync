import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/transfer.js', import.meta.url), 'utf8');
const bookId = 'TEST-BOOK';
const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const hash = async (data) => Buffer.from(await webcrypto.subtle.digest('SHA-256', data)).toString('hex');
const header = async (overrides = {}) => ({ type: 'book', bookId, size: bytes.length, sha256: await hash(bytes), ...overrides });

function setup({ messages, save, gather = true } = {}) {
  const requests = [], receipts = [];
  let peer, stored = false;
  class Channel extends EventTarget {
    readyState = 'open'; bufferedAmount = 0;
    send(value) { receipts.push({ value: JSON.parse(value), stored }); }
    message(data) { const event = new Event('message'); Object.defineProperty(event, 'data', { value: data }); this.dispatchEvent(event); }
  }
  class Peer extends EventTarget {
    iceGatheringState = gather ? 'complete' : 'gathering'; connectionState = 'new';
    constructor(config) { super(); assert.deepEqual(JSON.parse(JSON.stringify(config)), { iceServers: [] }); peer = this; }
    createDataChannel(label, options) { assert.equal(label, 'books-epub-v1'); assert.equal(options.ordered, true); return this.channel = new Channel(); }
    async createOffer() { return { type: 'offer', sdp: 'data-channel-offer' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) {
      assert.equal(value.type, 'answer');
      this.connectionState = 'connected';
      queueMicrotask(async () => { for (const value of await messages()) this.channel.message(typeof value === 'object' && !(value instanceof ArrayBuffer) ? JSON.stringify(value) : value); });
    }
    close() {
      if (this.connectionState === 'closed') return;
      this.connectionState = 'closed'; this.channel.readyState = 'closed';
      this.dispatchEvent(new Event('connectionstatechange'));
      this.channel.dispatchEvent(new Event('close'));
    }
  }
  const context = {
    window: {}, RTCPeerConnection: Peer, crypto: webcrypto, Blob, ArrayBuffer, Uint8Array,
    AbortController, DOMException, setTimeout, clearTimeout,
  };
  vm.runInNewContext(source, context);
  const controller = new AbortController();
  const receive = context.window.BookTransfer.receive({
    bookId, signal: controller.signal,
    request: async (path, options = {}) => {
      requests.push({ path, options });
      if (path === '/api/transfers') return { id: 'transfer-1', expiresAt: new Date(Date.now() + 180000).toISOString() };
      if (path.endsWith('/close')) return { ok: true };
      return { id: 'transfer-1', bookId, status: 'answered', answer: { type: 'answer', sdp: 'data-channel-answer' } };
    },
    save: async (blob) => {
      assert.equal(blob.type, 'application/epub+zip');
      assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
      if (save) await save(blob);
      stored = true;
      return { id: bookId, epub: blob };
    },
  });
  return { receive, controller, requests, receipts, get peer() { return peer; } };
}

test('only acknowledges after integrity verification and durable save; signaling has no book bytes', async () => {
  let release;
  const persisted = new Promise((resolve) => { release = resolve; });
  let saving;
  const started = new Promise((resolve) => { saving = resolve; });
  const flow = setup({
    messages: async () => [await header(), bytes.buffer.slice(0, 5), bytes.buffer.slice(5), { type: 'end' }],
    save: async () => { saving(); await persisted; },
  });
  await started;
  assert.equal(flow.receipts.length, 0);
  release();
  const result = await flow.receive;
  assert.equal(result.id, bookId);
  assert.deepEqual(flow.receipts, [{ value: { type: 'received' }, stored: true }]);
  assert.deepEqual(flow.requests.map((item) => item.path), ['/api/transfers', '/api/transfers/transfer-1', '/api/transfers/transfer-1/close']);
  const sent = JSON.parse(JSON.stringify(flow.requests[0].options.body));
  assert.deepEqual(sent, { bookId, offer: { type: 'offer', sdp: 'data-channel-offer' } });
  assert.equal(flow.peer.connectionState, 'closed');
});

for (const [name, messages, pattern] of [
  ['another book', async () => [await header({ bookId: 'OTHER-BOOK' })], /different or unsupported/],
  ['oversized file', async () => [await header({ size: 128 * 1024 * 1024 + 1 })], /different or unsupported/],
  ['chunk before header', async () => [bytes.buffer], /invalid book transfer/],
  ['too many bytes', async () => [await header({ size: 4 }), bytes.buffer], /invalid book transfer/],
  ['partial file', async () => [await header(), bytes.buffer.slice(0, 4), { type: 'end' }], /incomplete/],
  ['hash mismatch', async () => [await header({ sha256: '0'.repeat(64) }), bytes.buffer, { type: 'end' }], /integrity check/],
  ['non-EPUB archive', async () => {
    const wrong = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    return [await header({ sha256: await hash(wrong) }), wrong.buffer, { type: 'end' }];
  }, /not an EPUB archive/],
]) {
  test(`rejects ${name} without saving or acknowledging`, async () => {
    const flow = setup({ messages, save: () => assert.fail('Invalid transfer must not be saved') });
    await assert.rejects(flow.receive, pattern);
    assert.equal(flow.receipts.length, 0);
    assert.ok(flow.requests.some((item) => item.path.endsWith('/close')));
  });
}

test('storage failure is not acknowledged as saved', async () => {
  const flow = setup({
    messages: async () => [await header(), bytes.buffer, { type: 'end' }],
    save: () => { throw new DOMException('Storage full', 'QuotaExceededError'); },
  });
  await assert.rejects(flow.receive, { name: 'QuotaExceededError' });
  assert.equal(flow.receipts.length, 0);
});

test('cancelling ICE setup closes the connection without creating a server transfer', async () => {
  const flow = setup({ gather: false });
  flow.controller.abort();
  await assert.rejects(flow.receive, { name: 'AbortError' });
  assert.equal(flow.peer.connectionState, 'closed');
  assert.equal(flow.requests.length, 0);
  assert.equal(flow.receipts.length, 0);
});


test('cancellation during a pending durable save never sends a premature receipt', async () => {
  let release, started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const commit = new Promise((resolve) => { release = resolve; });
  const flow = setup({
    messages: async () => [await header(), bytes.buffer, { type: 'end' }],
    save: async () => { started(); await commit; },
  });
  await waiting;
  flow.controller.abort();
  await assert.rejects(flow.receive, { name: 'AbortError' });
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(flow.receipts.length, 0);
});

test('account change while IndexedDB opens rejects a stale transfer write', async () => {
  const storageSource = await readFile(new URL('../public/offline.js', import.meta.url), 'utf8');
  let openRequest, writes = 0, closed = false;
  const context = {
    window: {},
    indexedDB: { open() { return openRequest = {}; } },
  };
  vm.runInNewContext(storageSource, context);
  const storage = context.window.OfflineBooks;
  storage.setScope('account:first');
  const writing = storage.put({ id: bookId }, 'account:first');
  const closing = storage.closeScope();
  storage.setScope('account:second');
  openRequest.result = { close() { closed = true; }, transaction() { writes++; assert.fail('Stale transfer must not write'); } };
  openRequest.onsuccess();
  await assert.rejects(writing, /account changed/);
  await closing;
  assert.equal(writes, 0);
  assert.equal(closed, true);
  await assert.rejects(storage.put({ id: bookId }, 'account:first'), /account changed/);
});
