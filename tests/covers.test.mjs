import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

const source = await readFile(new URL('../public/covers.js', import.meta.url), 'utf8');
const storageSource = await readFile(new URL('../public/offline.js', import.meta.url), 'utf8');
const jpeg = new Uint8Array([255, 216, 255, 224, 0, 2, 255, 217]);
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const positive = (id = 'BOOK-A', data = jpeg) => ({ id, mime: 'image/jpeg', data: Buffer.from(data).toString('base64') });
const missing = (id = 'BOOK-B') => ({ id, mime: null, data: null });
const bundle = (covers, version = 1) => new Blob([JSON.stringify({ version, covers })], { type: 'application/json' });
function coversApi() {
  const context = { window: {}, Blob, Uint8Array, TextDecoder, JSZip, DOMParser, atob, fetch: () => assert.fail('Cover parsing must not fetch external resources') };
  vm.runInNewContext(source, context);
  return context.window.BookCovers;
}

async function epub({ version = 3, href = 'Images/cover.jpg', data = jpeg, packagePath = 'EPUB/package.opf', imagePath, metadata, container } = {}) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', container ?? `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${packagePath}" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file(packagePath, metadata ?? `<package xmlns="http://www.idpf.org/2007/opf" version="${version}.0"><metadata>${version === 2 ? '<meta name="cover" content="front"/>' : ''}</metadata><manifest><item id="front" href="${href}" media-type="image/jpeg" ${version === 3 ? 'properties="nav cover-image"' : ''}/></manifest></package>`);
  zip.file(imagePath ?? 'EPUB/Images/cover.jpg', data);
  return new Blob([await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })], { type: 'application/epub+zip' });
}

test('cover bundle returns only requested JPEGs and checked missing artwork', async () => {
  const records = await coversApi().readBundle(bundle([positive(), missing()]), ['BOOK-B', 'BOOK-A']);
  assert.deepEqual(Array.from(records, (record) => record.id), ['BOOK-A', 'BOOK-B']);
  assert.equal(records[0].cover.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await records[0].cover.arrayBuffer()), jpeg);
  assert.equal(records[1].cover, null);
  assert.equal(records[0].checkedAt, records[1].checkedAt);
  assert.ok(Number.isFinite(Date.parse(records[0].checkedAt)));
});

for (const [name, data] of [
  ['foreign book', [positive(), missing('FOREIGN')]],
  ['duplicate book', [positive(), positive()]],
  ['missing book', [positive()]],
  ['extra book', [positive(), missing(), missing('EXTRA')]],
  ['unsupported MIME', [{ ...positive(), mime: 'image/svg+xml' }, missing()]],
  ['incomplete missing entry', [{ ...missing('BOOK-A'), data: '' }, missing()]],
  ['invalid base64', [{ ...positive(), data: '!!==' }, missing()]],
  ['spoofed JPEG', [positive('BOOK-A', png), missing()]],
  ['truncated JPEG', [positive('BOOK-A', jpeg.subarray(0, -2)), missing()]],
  ['extra data fields', [{ ...positive(), url: 'https://example.test/cover.jpg' }, missing()]],
]) {
  test(`rejects the entire bundle for ${name}`, async () => {
    await assert.rejects(coversApi().readBundle(bundle(data), ['BOOK-A', 'BOOK-B']), /Invalid cover bundle/);
  });
}

test('bundle size, decoded image limit, version, and requested ID limits are enforced', async () => {
  const api = coversApi();
  const image = new Uint8Array(256 * 1024 + 1);
  image.set(jpeg.subarray(0, 3)); image.set([255, 217], image.length - 2);
  await assert.rejects(api.readBundle(bundle([positive('BOOK-A', image)]), ['BOOK-A']), /Invalid cover bundle/);
  await assert.rejects(api.readBundle(new Blob([new Uint8Array(16 * 1024 * 1024 + 1)]), ['BOOK-A']), /Invalid cover bundle/);
  await assert.rejects(api.readBundle(bundle([positive()], 2), ['BOOK-A']), /Invalid cover bundle/);
  await assert.rejects(api.readBundle(bundle([positive()]), ['BOOK-A', 'BOOK-A']), /Invalid cover bundle/);
  await assert.rejects(api.readBundle(bundle([]), Array.from({ length: 201 }, (_, i) => `BOOK-${i}`)), /Invalid cover bundle/);
  await assert.rejects(api.readBundle(bundle([]), []), /Invalid cover bundle/);
});

for (const version of [2, 3]) {
  test(`extracts EPUB ${version} cover metadata from a saved file without a network request`, async () => {
    const cover = await coversApi().fromEpub(await epub({ version }));
    assert.equal(cover.type, 'image/jpeg');
    assert.deepEqual(new Uint8Array(await cover.arrayBuffer()), jpeg);
  });
}

test('resolves a safe parent-relative escaped image path and detects its raster format', async () => {
  const book = await epub({ packagePath: 'EPUB/Package/book.opf', href: '../Images/front%20cover.png', imagePath: 'EPUB/Images/front cover.png', data: png });
  const cover = await coversApi().fromEpub(book);
  assert.equal(cover.type, 'image/png');
  assert.deepEqual(new Uint8Array(await cover.arrayBuffer()), png);
});

for (const href of ['https://example.test/cover.jpg', '//example.test/cover.jpg', '/Images/cover.jpg', '../../outside.jpg', '%2e%2e/%2e%2e/outside.jpg', 'Images\\cover.jpg', 'Images/cover.jpg?token=secret']) {
  test(`ignores unsafe cover reference ${href}`, async () => {
    assert.equal(await coversApi().fromEpub(await epub({ href })), null);
  });
}

test('missing, vector, malformed, and oversized EPUB cover data cannot block reading', async () => {
  const api = coversApi();
  assert.equal(await api.fromEpub(new Blob(['not a ZIP'])), null);
  assert.equal(await api.fromEpub(await epub({ metadata: '<package><manifest/></package>' })), null);
  assert.equal(await api.fromEpub(await epub({ data: '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>' })), null);
  assert.equal(await api.fromEpub(await epub({ metadata: '<!DOCTYPE package [<!ENTITY cover SYSTEM "https://example.test/secret">]><package/>' })), null);
  assert.equal(await api.fromEpub(await epub({ metadata: `<package>${' '.repeat(1024 * 1024)}</package>` })), null);
  const largeImage = new Uint8Array(4 * 1024 * 1024 + 1);
  largeImage.set(jpeg.subarray(0, 3)); largeImage.set([255, 217], largeImage.length - 2);
  assert.equal(await api.fromEpub(await epub({ data: largeImage })), null);
});

// This fake models the asynchronous IndexedDB transaction boundary, including
// abort before commit. Actual browser persistence is checked in the UI flow.
function storageApi({ holdOpen = false, holdRead = false } = {}) {
  const databases = new Map(), opens = [], pendingReads = [], transactions = [];
  const indexedDB = {
    open(name, version) {
      assert.equal(version, 1, 'Cover caching must not upgrade the existing database');
      const request = {};
      if (!databases.has(name)) databases.set(name, new Map());
      request.result = {
        close() {},
        transaction(storeName, mode) {
          assert.equal(storeName, 'library', 'Cover caching must not rewrite an EPUB or reading position');
          const snapshot = new Map(databases.get(name));
          let aborted = false;
          const tx = { mode, abort() { aborted = true; queueMicrotask(() => tx.onabort?.()); } };
          const store = {
            get(key) {
              const getRequest = {};
              const read = () => {
                if (aborted) return;
                getRequest.result = snapshot.get(key);
                getRequest.onsuccess?.();
                queueMicrotask(() => {
                  if (aborted) return;
                  if (mode === 'readwrite') databases.set(name, snapshot);
                  tx.oncomplete?.();
                });
              };
              if (holdRead) pendingReads.push(read); else queueMicrotask(read);
              return getRequest;
            },
            put(value, key) { snapshot.set(key, value); return { result: key }; },
          };
          tx.objectStore = (requested) => { assert.equal(requested, 'library'); return store; };
          transactions.push(tx);
          return tx;
        },
      };
      opens.push(request);
      if (!holdOpen) queueMicrotask(() => request.onsuccess());
      return request;
    },
  };
  const context = { window: {}, indexedDB, Blob };
  vm.runInNewContext(storageSource, context);
  const storage = context.window.OfflineBooks;
  storage.setScope('account:first');
  return { storage, databases, opens, transactions, releaseRead() { pendingReads.shift()(); } };
}
const record = (id = 'BOOK-A', cover = new Blob([jpeg], { type: 'image/jpeg' }), extra = {}) => ({ id, cover, checkedAt: new Date().toISOString(), ...extra });

test('cover cache merges durably without changing saved EPUBs or erasing positive artwork', async () => {
  const { storage } = storageApi();
  await storage.putCovers([record(), record('BOOK-B', null, { availableOnMac: false })], 'account:first');
  const replacement = new Blob([png], { type: 'image/png' });
  const merged = await storage.putCovers([record('BOOK-A', null), record('BOOK-B', replacement, { availableOnMac: true }), record('BOOK-C', null)], 'account:first');
  assert.equal(merged.length, 3);
  const saved = new Map((await storage.listCovers()).map((item) => [item.id, item]));
  assert.equal(saved.get('BOOK-A').cover.type, 'image/jpeg');
  assert.equal(saved.get('BOOK-B').cover, replacement);
  assert.equal(saved.get('BOOK-B').availableOnMac, true);
  assert.equal(saved.get('BOOK-C').cover, null);
  await assert.rejects(storage.putCovers([record('BOOK-D', null, { availableOnMac: 'yes' })], 'account:first'), /Invalid cover records/);
});

test('account change while the cover database opens prevents the stale write', async () => {
  const fixture = storageApi({ holdOpen: true });
  const writing = fixture.storage.putCovers([record()], 'account:first');
  const closing = fixture.storage.closeScope();
  fixture.storage.setScope('account:second');
  fixture.opens[0].onsuccess();
  await assert.rejects(writing, /account changed/);
  await closing;
  assert.equal(fixture.transactions.length, 0);
  await assert.rejects(fixture.storage.putCovers([record()], 'account:first'), /account changed/);
  assert.equal(fixture.opens.length, 1);
});

test('account change while an existing cover record is read aborts the entire merge', async () => {
  const fixture = storageApi({ holdRead: true });
  const writing = fixture.storage.putCovers([record()], 'account:first');
  await new Promise((resolve) => setImmediate(resolve));
  const closing = fixture.storage.closeScope();
  fixture.storage.setScope('account:second');
  fixture.releaseRead();
  await assert.rejects(writing, /account changed/);
  await closing;
  assert.equal(fixture.databases.values().next().value.size, 0);
});
