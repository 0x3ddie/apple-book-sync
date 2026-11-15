"use strict";

// Book files stay in this browser. No cloud upload or background bulk download.
const OfflineBooks = window.OfflineBooks = (() => {
  let database, shell, scope;
  const databaseName = () => scope === "local" ? "books-on-this-device" : `books-on-this-device:${encodeURIComponent(scope)}`;
  function open() {
    if (!scope) return Promise.reject(new Error("Sign in before opening device storage."));
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName(), 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("books", { keyPath: "id" });
        request.result.createObjectStore("library");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return database;
  }
  async function closeScope() {
    const pending = database;
    scope = null;
    database = null;
    if (pending) {
      const db = await pending.catch(() => null);
      db?.close();
    }
  }
  async function transaction(store, mode, operation, expectedScope) {
    const operationScope = scope;
    if (expectedScope && expectedScope !== operationScope) throw new Error("Your account changed. Reopen your library before saving books.");
    const db = await open();
    if (scope !== operationScope) throw new Error("Your account changed. Reopen your library before saving books.");
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const request = operation(tx.objectStore(store));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error || request.error);
      tx.onabort = () => reject(tx.error || new Error("Device storage was interrupted."));
    });
  }
  function prepareShell() {
    if (!shell) shell = (async () => {
      if (!("serviceWorker" in navigator)) throw new Error("Offline reading needs a supported browser on HTTPS or localhost.");
      const registration = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
      const worker = registration.installing || registration.waiting;
      const activation = worker ? new Promise((resolve, reject) => {
        function check() {
          if (worker.state === "activated") { worker.removeEventListener("statechange", check); resolve(); }
          else if (worker.state === "redundant") { worker.removeEventListener("statechange", check); reject(new Error("The offline reader update did not finish. Please try saving again.")); }
        }
        worker.addEventListener("statechange", check);
        check();
      }) : Promise.resolve();
      let timer;
      try {
        await Promise.race([
          Promise.all([navigator.serviceWorker.ready, activation]),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The offline reader could not be saved. Please try again while connected.")), 15000); }),
        ]);
      } finally { clearTimeout(timer); }
    })().catch((error) => { shell = null; throw error; });
    return shell;
  }
  return {
    setScope(value) {
      if (typeof value !== "string" || !value || value.length > 200) throw new Error("Invalid account storage scope.");
      if (database && scope !== value) throw new Error("Reload the reader before switching accounts.");
      scope = value;
    },
    closeScope,
    async clearScope() {
      if (!scope) return;
      const name = databaseName();
      await closeScope();
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("Close this reader in other tabs, then sign out again to remove its downloads."));
      });
      scope = null;
    },
    prepareShell,
    list: () => transaction("books", "readonly", (store) => store.getAll()),
    get: (id) => transaction("books", "readonly", (store) => store.get(id)),
    put: (record, expectedScope) => transaction("books", "readwrite", (store) => store.put(record), expectedScope),
    remove: (id) => transaction("books", "readwrite", (store) => store.delete(id)),
    saveLibrary: (books) => transaction("library", "readwrite", (store) => store.put(books, "catalogue")),
    readLibrary: () => transaction("library", "readonly", (store) => store.get("catalogue")),
    listCovers: async () => await transaction("library", "readonly", (store) => store.get("covers")) || [],
    async putCovers(records, expectedScope) {
      if (!Array.isArray(records) || records.some((record) => !record || typeof record.id !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(record.id)
        || record.cover !== null && !(record.cover instanceof Blob) || typeof record.checkedAt !== "string" || !Number.isFinite(Date.parse(record.checkedAt))
        || record.availableOnMac !== undefined && typeof record.availableOnMac !== "boolean")) {
        throw new Error("Invalid cover records.");
      }
      const operationScope = scope;
      const changed = () => !operationScope || scope !== operationScope || expectedScope && expectedScope !== operationScope;
      const accountError = () => new Error("Your account changed. Reopen your library before saving covers.");
      if (changed()) throw accountError();
      const db = await open();
      if (changed()) throw accountError();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("library", "readwrite"), store = tx.objectStore("library");
        const request = store.get("covers");
        let merged, failure;
        request.onsuccess = () => {
          if (changed()) { failure = accountError(); tx.abort(); return; }
          const covers = new Map((request.result || []).map((record) => [record.id, record]));
          for (const record of records) {
            // An absent Mac image must not erase a cover extracted concurrently
            // from the already-saved EPUB in another task or tab.
            if (record.cover === null && covers.get(record.id)?.cover) continue;
            covers.set(record.id, { id: record.id, cover: record.cover, checkedAt: record.checkedAt,
              ...(record.availableOnMac !== undefined ? { availableOnMac: record.availableOnMac } : {}) });
          }
          merged = [...covers.values()];
          store.put(merged, "covers");
        };
        tx.oncomplete = () => changed() ? reject(accountError()) : resolve(merged);
        tx.onerror = () => reject(tx.error || request.error);
        tx.onabort = () => reject(failure || tx.error || new Error("Cover storage was interrupted."));
      });
    },
    async updateDetail(detail) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("books", "readwrite"), store = tx.objectStore("books");
        const request = store.get(detail.id);
        request.onsuccess = () => { if (request.result) store.put({ ...request.result, detail }); };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Could not update the saved book."));
      });
    },
  };
})();
