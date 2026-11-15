import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/reader.js', import.meta.url), 'utf8');
const cfi = (page) => `epubcfi(/6/2!/4/${page}:0)`;
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
class Element extends EventTarget {
  hidden = false; disabled = false; textContent = ''; children = []; returnValue = ''; modalCount = 0;
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
  showModal() { this.modalCount++; }
  close(value) { this.returnValue = value; this.dispatchEvent(new Event('close')); }
}
function setup({ response, storeDetail = async () => {} } = {}) {
  const elements = new Map(), local = new Map(), requests = [], timers = new Map();
  let nextTimer = 0;
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const document = Object.assign(new EventTarget(), {
    getElementById: get, createElement: () => new Element(), querySelectorAll: () => [], visibilityState: 'visible',
  });
  const window = Object.assign(new EventTarget(), {
    ReaderAccount: { current: { mode: 'cloud', scope: 'account:reader', user: { id: 'reader' } }, ready: new Promise(() => {}) },
  });
  const context = vm.createContext({
    window, document, Event, Headers, AbortSignal, AbortController, URL, crypto: webcrypto,
    localStorage: { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) },
    matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
    navigator: { onLine: true },
    OfflineBooks: { updateDetail: storeDetail },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (path, options) => {
      requests.push({ path, body: options.body && JSON.parse(options.body), headers: options.headers });
      const result = await response(path, options);
      return { ok: (result.status ?? 200) === 200, status: result.status ?? 200, async json() { return result.body ?? result; } };
    },
  });
  vm.runInContext(source, context);
  const state = vm.runInContext('state', context);
  state.accountReady = true;
  return {
    context, state, window, document, get, local, requests, timers,
    async tick() { const next = timers.entries().next().value; assert.ok(next, 'Sync check should be scheduled'); timers.delete(next[0]); await next[1].callback(); },
  };
}
const web = (patch = {}) => ({ cfi: cfi(10), clientId: 'other-web', sequence: 1, revision: 4, savedAt: '2026-11-14T20:00:00Z', appleRevision: 'apple-before', ...patch });
const detail = (patch = {}) => ({ id: 'book', title: 'Book', applePosition: { cfi: cfi(2), revision: 'new-apple' }, webPosition: web(), syncState: 'pending', resume: { cfi: cfi(10), source: 'web' }, ...patch });
const backup = (patch = {}) => ({ id: 'book', cfi: cfi(12), clientId: 'this-web', sequence: 2, baseRevision: 4, appleRevision: 'old-apple', savedLocallyAt: '2026-11-14T21:00:00Z', ...patch });

test('a pending web position automatically wins an Apple-only conflict, including old cached metadata', async () => {
  const qa = setup();
  for (const syncState of ['pending', 'conflict']) {
    const result = await qa.context.resolvePosition(detail({ syncState, resume: { cfi: cfi(2), source: 'apple' } }));
    assert.equal(result.cfi, cfi(10)); assert.equal(result.source, 'web'); assert.equal(result.saveChoice, false);
  }
  assert.equal(qa.get('position-dialog').modalCount, 0);
});

test('unsent offline progress wins changed Apple metadata without a position dialog', async () => {
  const qa = setup();
  const result = await qa.context.resolvePosition(detail(), backup());
  assert.equal(result.cfi, cfi(12)); assert.equal(result.source, 'local'); assert.equal(result.saveChoice, true);
  assert.equal(qa.get('position-dialog').modalCount, 0);
});

test('confirmed web progress permits later Apple progress to resume automatically', async () => {
  const qa = setup();
  const synced = await qa.context.resolvePosition(detail({ syncState: 'synced' }));
  assert.equal(synced.cfi, cfi(10));
  const laterApple = detail({ syncState: 'apple', resume: { cfi: cfi(20), source: 'apple' } });
  const result = await qa.context.resolvePosition(laterApple);
  assert.equal(result.cfi, cfi(20)); assert.equal(result.source, 'apple'); assert.equal(result.saveChoice, false);
  const oldAcknowledgedBackup = await qa.context.resolvePosition(laterApple, backup({ cfi: cfi(10) }));
  assert.equal(oldAcknowledgedBackup.cfi, cfi(20), 'A previously saved local backup must not send the old web location again');
});

test('another web device cannot silently replace genuinely unsent local reading', async () => {
  const qa = setup();
  const result = qa.context.resolvePosition(detail(), backup({ baseRevision: 3 }));
  assert.equal(qa.get('position-dialog').modalCount, 1);
  const labels = qa.get('position-choices').children.map(button => button.children[0].textContent);
  assert.deepEqual(labels, ['Use this device’s unsent position', 'Use the saved web position']);
  qa.get('position-dialog').close('local');
  assert.equal((await result).cfi, cfi(12));
});

test('an already superseded same-session backup cannot move the reader backward', async () => {
  const qa = setup();
  const result = await qa.context.resolvePosition(detail({ webPosition: web({ clientId: 'this-web', sequence: 5 }) }), backup({ sequence: 4 }));
  assert.equal(result.cfi, cfi(10)); assert.equal(result.saveChoice, false);
});

test('cloud save waits for durable device cache and stays pending until native acknowledgement', async () => {
  const stored = deferred();
  let saved;
  const qa = setup({
    storeDetail: () => stored.promise,
    response: (path, options) => {
      if (options.method === 'POST') { saved = { ...JSON.parse(options.body), revision: 5 }; return { position: saved, syncState: 'pending' }; }
      return detail({ webPosition: { ...saved, applied: { deviceId: 'mac' } }, syncState: 'synced' });
    },
  });
  qa.state.detail = detail();
  qa.state.savedBooks.set('book', { detail: detail() });
  const draft = qa.context.markDraft(cfi(12), 'chapter.xhtml');
  const saving = qa.context.saveDraft(draft);
  await flush();
  assert.ok(qa.context.readBackup('book'), 'Do not clear local recovery before the saved EPUB metadata is durable');
  assert.notEqual(qa.get('reader-status').textContent, 'Synced with Apple Books');
  stored.resolve(); await saving;
  assert.equal(qa.context.readBackup('book'), null);
  assert.equal(qa.state.detail.syncState, 'pending');
  assert.equal(qa.get('reader-status').textContent, 'Position saved');
  assert.equal(qa.timers.size, 1);
  assert.equal(qa.requests[0].headers.get('X-Books-Account'), 'reader');
  await qa.tick();
  assert.equal(qa.get('reader-status').textContent, 'Synced with Apple Books');
  assert.equal(qa.timers.size, 0);
});

test('a competing-web save rejection preserves offline recovery and offers retry', async () => {
  const qa = setup({ response: () => ({ status: 409, body: { error: 'Another reader saved a newer position.' } }) });
  qa.state.detail = detail();
  const draft = qa.context.markDraft(cfi(12), 'chapter.xhtml');
  await assert.rejects(qa.context.saveDraft(draft), /newer position/);
  assert.equal(qa.context.readBackup('book').cfi, cfi(12));
  assert.equal(qa.get('retry-save').hidden, false);
  assert.equal(qa.timers.size, 0);
});

test('a late acknowledgement cannot replace a newer page turn or mark it synced', async () => {
  const answer = deferred();
  const qa = setup({ response: () => answer.promise });
  qa.state.detail = detail(); qa.context.watchAppleSync();
  const checking = qa.tick();
  qa.context.markDraft(cfi(14), 'chapter.xhtml');
  answer.resolve(detail({ syncState: 'synced' })); await checking;
  assert.equal(qa.state.draft.cfi, cfi(14));
  assert.notEqual(qa.get('reader-status').textContent, 'Synced with Apple Books');
  assert.equal(qa.timers.size, 0);
});

test('account changes cancel acknowledgement checks and ignore an in-flight result', async () => {
  const answer = deferred();
  const qa = setup({ response: () => answer.promise });
  qa.state.detail = detail(); qa.context.watchAppleSync();
  const checking = qa.tick();
  qa.window.dispatchEvent(new Event('books-account-changing'));
  const before = qa.get('reader-status').textContent;
  answer.resolve(detail({ syncState: 'synced' })); await checking;
  assert.equal(qa.get('reader-status').textContent, before);
  assert.equal(qa.timers.size, 0);
});

test('waiting for an offline Mac does not poll indefinitely', async () => {
  const qa = setup({ response: () => detail() });
  qa.state.detail = detail(); qa.context.watchAppleSync();
  for (let index = 0; index < 12; index++) await qa.tick();
  assert.equal(qa.timers.size, 0); assert.equal(qa.requests.length, 12);
  assert.notEqual(qa.get('reader-status').textContent, 'Synced with Apple Books');
});


test('an older save response cannot mark a newer pending revision as applied', async () => {
  const answer = deferred();
  const qa = setup({ response: () => answer.promise });
  qa.state.detail = detail();
  const old = backup();
  const saving = qa.context.sendDraft(old);
  qa.state.detail.webPosition = web({ revision: 6, cfi: cfi(16) });
  qa.state.detail.syncState = 'pending';
  answer.resolve({ position: web({ revision: 5, cfi: old.cfi }), syncState: 'synced' });
  await saving;
  assert.equal(qa.state.detail.webPosition.revision, 6);
  assert.equal(qa.state.detail.syncState, 'pending');
});

test('reconnecting checks a previously saved pending position without another button', async () => {
  const qa = setup({ response: () => detail({ syncState: 'synced' }) });
  qa.state.detail = detail(); qa.state.bridgeOnline = false;
  qa.window.dispatchEvent(new Event('online'));
  await qa.tick();
  assert.equal(qa.state.bridgeOnline, true);
  assert.equal(qa.get('reader-status').textContent, 'Synced with Apple Books');
});
