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
  dataset = {}; style = { setProperty() {} }; value = ''; className = ''; parent = null;
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  querySelectorAll(selector) {
    const classes = selector.split(',').map(item => item.trim()).filter(item => item.startsWith('.')).map(item => item.slice(1));
    return this.children.flatMap(child => [...(classes.some(name => child.className.split(' ').includes(name)) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  replaceWith(node) { node.parent = this.parent; this.parent.children = this.parent.children.map(child => child === this ? node : child); }
  setAttribute() {}
  focus() {}
  showModal() { this.modalCount++; }
  close(value) { this.returnValue = value; this.dispatchEvent(new Event('close')); }
}
function setup({ response, storeDetail = async () => {} } = {}) {
  const elements = new Map(), local = new Map(), requests = [], timers = new Map();
  let nextTimer = 0;
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const document = Object.assign(new EventTarget(), {
    getElementById: get, createElement: () => new Element(),
    querySelectorAll: selector => [...new Set([...elements.values()].flatMap(element => element.querySelectorAll(selector)))], visibilityState: 'visible',
  });
  const window = Object.assign(new EventTarget(), {
    ReaderAccount: { current: { mode: 'cloud', scope: 'account:reader', user: { id: 'reader' } }, ready: new Promise(() => {}) },
  });
  const context = vm.createContext({
    window, document, Event, Headers, AbortSignal, AbortController, URL, crypto: webcrypto,
    localStorage: { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) },
    matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
    navigator: { onLine: true },
    OfflineBooks: { updateDetail: storeDetail, saveLibrary: async () => {} },
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
const detail = (patch = {}) => ({ id: 'book', title: 'Book', progress: .4, readable: true, applePosition: { cfi: cfi(2), revision: 'new-apple' }, webPosition: web(), syncState: 'pending', resume: { cfi: cfi(10), source: 'web' }, ...patch });
const summary = (book = detail()) => {
  const { webPosition, applePosition, resume, ...rest } = book;
  return { ...rest, webRevision: webPosition.revision, deliveryAttempt: webPosition.delivered?.attempt ?? (webPosition.delivered ? 1 : 0) };
};
const sentDetail = attempt => detail({ syncState: 'sent', webPosition: web({ delivered: { deviceId: 'mac', applePosition: null, ...(attempt ? { attempt } : {}) } }) });
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
  assert.equal(qa.get('reader-status').textContent, 'Saved · waiting for Mac');
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
  for (let index = 0; index < 24; index++) await qa.tick();
  assert.equal(qa.timers.size, 0); assert.equal(qa.requests.length, 24);
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


test('unconfirmed delivery keeps checking through bounded retries without claiming sync', async () => {
  let sent = sentDetail();
  const qa = setup({ response: () => sent });
  qa.state.detail = detail(); qa.context.watchAppleSync();
  await qa.tick();
  assert.equal(qa.get('reader-status').textContent, 'Apple Books hasn’t confirmed this passage');
  assert.equal(qa.get('save-detail').textContent, 'Retrying automatically while your Mac is online.');
  assert.equal(qa.timers.size, 1);
  assert.equal(qa.state.detail.syncState, 'sent');
  const selected = await qa.context.resolvePosition(sent);
  assert.equal(selected.source, 'web'); assert.equal(selected.cfi, cfi(10));
  sent = sentDetail(2); await qa.tick();
  assert.equal(qa.timers.size, 1);
  sent = sentDetail(3); await qa.tick();
  assert.equal(qa.get('reader-status').textContent, 'Saved on web; Apple Books position unconfirmed');
  assert.equal(qa.get('save-detail').textContent, 'Your web position is saved; Apple Books hasn’t confirmed this passage.');
  assert.equal(qa.timers.size, 0);
  qa.context.watchAppleSync();
  assert.equal(qa.timers.size, 0, 'Exhausted native attempts must not start another polling window');
});

test('an idempotent save response with delivery remains sent rather than confirmed', async () => {
  const qa = setup({ response: (_path, options) => ({ position: { ...JSON.parse(options.body), revision: 5 }, syncState: 'sent', ignored: true }) });
  qa.state.detail = detail();
  await qa.context.saveDraft(qa.context.markDraft(cfi(12), 'chapter.xhtml'));
  assert.equal(qa.get('reader-status').textContent, 'Apple Books hasn’t confirmed this passage');
  assert.equal(qa.get('save-detail').textContent, 'Retrying automatically while your Mac is online.');
  assert.equal(qa.timers.size, 1);
});


test('later Apple progress after delivery is not described as exact web-position confirmation', async () => {
  const qa = setup({ response: () => detail({ syncState: 'apple', resume: { cfi: cfi(20), source: 'apple' }, webPosition: web({ delivered: { deviceId: 'mac' } }) }) });
  qa.state.detail = detail(); qa.context.watchAppleSync();
  await qa.tick();
  assert.equal(qa.get('reader-status').textContent, 'Apple Books progress updated');
  assert.equal(qa.get('save-detail').textContent, 'Your next session will resume from Apple Books.');
  assert.equal(qa.timers.size, 0);
});

test('Done keeps both library cards current without fetching the library or covers again', async () => {
  let fresh = detail();
  const qa = setup({ response: path => path === '/api/library' ? { books: [summary(fresh)] } : fresh });
  qa.state.detail = detail();
  await qa.context.finishReading();
  assert.equal(qa.state.detail, null);
  assert.equal(qa.get('library-view').hidden, false);
  assert.equal(qa.timers.size, 1);
  const labels = () => qa.document.querySelectorAll('.pending-label').map(node => node.textContent);
  assert.deepEqual(labels(), ['Saved · waiting for Mac', 'Saved · waiting for Mac']);
  const covers = qa.document.querySelectorAll('.cover');
  const download = qa.document.querySelectorAll('.download-button')[0];

  fresh = sentDetail(2); await qa.tick();
  assert.deepEqual(labels(), Array(2).fill('Apple Books hasn’t confirmed this passage · retrying automatically'));
  assert.equal(qa.timers.size, 1);
  fresh = detail({ progress: .6, syncState: 'synced', webPosition: web({ applied: { deviceId: 'mac' } }) });
  await qa.tick();
  assert.deepEqual(labels(), ['Synced with Apple Books', 'Synced with Apple Books']);
  assert.deepEqual(qa.document.querySelectorAll('.book-progress').map(node => node.textContent), ['60%', '60%']);
  assert.deepEqual(qa.document.querySelectorAll('.cover'), covers);
  assert.equal(qa.document.querySelectorAll('.download-button')[0], download);
  assert.deepEqual(qa.requests.map(request => request.path), ['/api/library', '/api/books/book', '/api/books/book']);
  assert.equal(qa.timers.size, 0);
});

test('an exhausted delivery is visibly unconfirmed on a fresh library visit and never polls', async () => {
  const qa = setup({ response: () => ({ books: [summary(sentDetail(3))] }) });
  await qa.context.refreshLibrary();
  assert.deepEqual(qa.document.querySelectorAll('.pending-label').map(node => node.textContent),
    Array(2).fill('Saved on web; Apple Books position unconfirmed'));
  assert.equal(qa.timers.size, 0);
});

test('late library checks cannot cross account changes, hidden views, another opened book or newer revisions', async () => {
  for (const change of ['account', 'hidden', 'opened', 'revision']) {
    const answer = deferred();
    const qa = setup({ response: () => answer.promise });
    qa.state.books = [summary()]; qa.context.renderLibrary(); qa.context.watchAppleSync();
    const checking = qa.tick();
    if (change === 'account') qa.window.dispatchEvent(new Event('books-account-changing'));
    if (change === 'hidden') {
      qa.document.visibilityState = 'hidden'; qa.document.dispatchEvent(new Event('visibilitychange'));
    }
    if (change === 'opened') {
      qa.context.OfflineBooks.get = () => new Promise(() => {});
      qa.context.openBook('another-book');
    }
    if (change === 'revision') qa.state.books[0].webRevision = 5;
    answer.resolve(detail({ syncState: 'synced' })); await checking;
    assert.equal(qa.state.books[0].syncState, 'pending', change);
    assert.deepEqual(qa.document.querySelectorAll('.pending-label').map(node => node.textContent),
      ['Saved · waiting for Mac', 'Saved · waiting for Mac'], change);
    assert.equal(qa.timers.size, 0, change);
  }
});

test('an expired response from the previous account cannot sign out the next account', async () => {
  const answer = deferred();
  const qa = setup({ response: () => answer.promise });
  qa.state.books = [summary()]; qa.context.watchAppleSync();
  const checking = qa.tick();
  qa.window.dispatchEvent(new Event('books-account-changing'));
  qa.window.ReaderAccount.current = { mode: 'cloud', scope: 'account:next', user: { id: 'next' } };
  qa.state.accountReady = true;
  answer.resolve({ status: 401, body: { error: 'Expired previous session' } }); await checking;
  assert.equal(qa.state.accountReady, true);
  assert.equal(qa.timers.size, 0);
});

test('returning to a visible library resumes only its affected-book status check', async () => {
  const qa = setup({ response: () => detail({ syncState: 'apple', resume: { cfi: cfi(20), source: 'apple' } }) });
  qa.state.books = [summary()]; qa.context.renderLibrary(); qa.context.watchAppleSync();
  qa.document.visibilityState = 'hidden'; qa.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(qa.timers.size, 0); assert.equal(qa.requests.length, 0);
  qa.document.visibilityState = 'visible'; qa.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(qa.timers.size, 1);
  await qa.tick();
  assert.deepEqual(qa.requests.map(request => request.path), ['/api/books/book']);
  assert.equal(qa.state.books[0].syncState, 'apple');
  assert.equal(qa.document.querySelectorAll('.pending-label').every(node => node.hidden), true);
  assert.equal(qa.timers.size, 0);
});

test('a later web revision ends the library check without falsely confirming the displayed revision', async () => {
  const qa = setup({ response: () => detail({ syncState: 'synced', webPosition: web({ revision: 5 }) }) });
  qa.state.books = [summary()]; qa.context.watchAppleSync();
  await qa.tick();
  assert.equal(qa.state.books[0].webRevision, 4);
  assert.equal(qa.state.books[0].syncState, 'pending');
  assert.equal(qa.timers.size, 0);
});

test('uploading an offline backup updates the library revision before watching its Mac confirmation', async () => {
  let saved;
  const qa = setup({ response: (_path, options) => {
    if (options.method === 'POST') {
      saved = { ...JSON.parse(options.body), revision: 5 };
      return { position: saved, syncState: 'pending' };
    }
    return detail({ webPosition: saved, syncState: 'synced' });
  } });
  qa.state.books = [summary()]; qa.context.storeBackup(backup());
  qa.context.watchAppleSync(); assert.equal(qa.timers.size, 0, 'Unsent recovery must not be labelled synced');
  await qa.context.syncBackups();
  assert.equal(qa.state.books[0].webRevision, 5);
  assert.equal(qa.context.readBackup('book'), null);
  assert.equal(qa.timers.size, 1);
  await qa.tick();
  assert.equal(qa.state.books[0].syncState, 'synced');
  assert.equal(qa.timers.size, 0);
});

test('library checks stop at the visible-visit budget even when the Mac never retries', async () => {
  const qa = setup({ response: () => sentDetail(1) });
  qa.state.books = [summary(sentDetail(1))]; qa.context.watchAppleSync();
  for (let index = 0; index < 24; index++) await qa.tick();
  assert.equal(qa.requests.length, 24);
  assert.equal(qa.timers.size, 0);
  assert.equal(qa.state.books[0].syncState, 'sent');
});
