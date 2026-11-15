"use strict";

const el = (id) => document.getElementById(id);
const clientId = crypto.randomUUID();
let storagePrefix = "books-pending:";
const state = {
  books: [], filter: "all", detail: null, epub: null, rendition: null,
  location: null, currentCfi: null, ready: false, opening: false,
  sequence: 0, draft: null, saveQueue: Promise.resolve(),
  navigation: null, libraryRequest: 0, storageWarning: false,
  savedBooks: new Map(), coverUrls: new Map(), downloads: new Map(), bridgeOnline: true,
  covers: new Map(), coverBackfilled: new Set(), coverSync: null, coverAttemptedAt: 0,
  offlineReady: false, syncingBackups: false,
  accountReady: false, anchorCfi: null,
};

// Display preferences are per device, not per account, and hold no book data.
const settingsKey = "books-reader-settings";
const readerThemes = {
  white: { bg: "#ffffff", fg: "#1d1d1f", link: "#b9530f" },
  sepia: { bg: "#f6eedc", fg: "#3e3221", link: "#9a4a12" },
  paper: { bg: "#f0efea", fg: "#2b2b2a", link: "#9a4a12" },
  dusk: { bg: "#3a3a3c", fg: "#e2e2e6", link: "#ffb44d" },
  night: { bg: "#000000", fg: "#c9c9ce", link: "#ff9f0a" },
};
const readerFonts = {
  serif: '"Iowan Old Style", "Charter", "Georgia", "Noto Serif", serif',
  sans: '-apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, sans-serif',
  original: null,
};
const textSizes = [70, 80, 90, 100, 110, 120, 135, 150, 175, 200];
const darkScheme = matchMedia("(prefers-color-scheme: dark)");
const readerSettings = (() => {
  const defaults = { size: 100, theme: null, font: "serif" };
  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey)) || {};
    return {
      size: textSizes.includes(saved.size) ? saved.size : defaults.size,
      // No saved theme means "follow the system light or dark setting".
      theme: Object.hasOwn(readerThemes, saved.theme) ? saved.theme : defaults.theme,
      font: Object.hasOwn(readerFonts, saved.font) ? saved.font : defaults.font,
    };
  } catch { return defaults; }
})();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers);
  const account = window.ReaderAccount.current;
  if (account?.mode === "cloud") headers.set("X-Books-Account", account.user.id);
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000), ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      state.accountReady = false;
      state.ready = false;
      window.dispatchEvent(new Event("books-session-expired"));
    }
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function showError(id, message) {
  el(id).textContent = message || "";
  el(id).hidden = !message;
}

function readBackup(id) {
  try {
    const saved = JSON.parse(localStorage.getItem(storagePrefix + id));
    return saved && saved.id === id && typeof saved.cfi === "string" && saved.cfi.startsWith("epubcfi(") ? saved : null;
  } catch { return null; }
}

function storeBackup(draft) {
  try {
    localStorage.setItem(storagePrefix + draft.id, JSON.stringify(draft));
    state.storageWarning = false;
  } catch {
    state.storageWarning = true;
    showError("reader-error", "This browser cannot keep an offline backup. Stay connected until your position is saved.");
  }
}

function removeBackup(draft) {
  const saved = readBackup(draft.id);
  if (!saved || saved.clientId !== draft.clientId || saved.sequence !== draft.sequence) return;
  try { localStorage.removeItem(storagePrefix + draft.id); } catch { /* Saved on the server; cleanup can wait. */ }
}

function bookMeta(book) {
  const progress = Number(book.progress);
  const meta = element("div", "book-meta");
  if (progress >= .99) meta.append(element("p", "book-progress finished", "Finished"));
  else if (progress > 0) {
    const track = element("span", "progress-track");
    const fill = element("span");
    fill.style.width = `${Math.min(100, Math.max(0, progress * 100))}%`;
    track.append(fill);
    const label = element("p", "book-progress", `${Math.max(1, Math.round(progress * 100))}%`);
    label.title = "Progress in Apple Books";
    meta.append(track, label);
  } else return null;
  return meta;
}

function coverHue(text) {
  let hash = 0;
  for (const character of text) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  return hash % 360;
}

function coverFor(book) {
  const cover = element("div", "cover");
  cover.dataset.bookId = book.id;
  cover.setAttribute("aria-hidden", "true");
  cover.style.setProperty("--cover-hue", coverHue(`${book.title}${book.author || ""}`));
  cover.append(element("span", "cover-title", book.title), element("span", "cover-author", book.author || ""));
  const coverUrl = state.coverUrls.get(book.id) || (state.bridgeOnline ? book.coverUrl : null);
  if (coverUrl) showCover(cover, coverUrl);
  return cover;
}

function showCover(cover, url) {
  let image = cover.querySelector("img");
  if (!image) {
    image = element("img");
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("error", () => image.remove(), { once: true });
    cover.append(image);
  }
  if (image.src !== url) image.src = url;
}

function rememberCovers(records) {
  for (const record of records) {
    // A missing Mac cover must not replace one extracted from a saved EPUB.
    if (state.covers.get(record.id)?.cover && !record.cover) continue;
    state.covers.set(record.id, record);
    if (!record.cover) continue;
    const previous = state.coverUrls.get(record.id);
    if (previous) URL.revokeObjectURL(previous);
    state.coverUrls.set(record.id, URL.createObjectURL(record.cover));
  }
  // Update images without rebuilding the shelf or moving keyboard focus.
  for (const cover of document.querySelectorAll(".cover[data-book-id]")) {
    const url = state.coverUrls.get(cover.dataset.bookId);
    if (url) showCover(cover, url);
  }
}

function sameAccount(scope) {
  return state.accountReady && window.ReaderAccount.current?.scope === scope;
}

function coverStatus(message) {
  el("cover-status").textContent = message;
  el("cover-status").hidden = !message;
}

async function backfillCovers(records, scope) {
  for (const record of records) {
    if (!sameAccount(scope)) return;
    if (state.covers.get(record.id)?.cover || state.coverBackfilled.has(record.id)) continue;
    state.coverBackfilled.add(record.id);
    let cover;
    try { cover = record.cover || await window.BookCovers.fromEpub(record.epub); }
    catch { continue; /* An unsupported cover does not prevent reading its book. */ }
    if (!sameAccount(scope)) return;
    if (!cover) continue;
    const cached = { id: record.id, cover, checkedAt: new Date().toISOString() };
    try { await OfflineBooks.putCovers([cached], scope); }
    catch {
      if (sameAccount(scope)) coverStatus("Cover images couldn’t be saved on this device.");
      return;
    }
    if (sameAccount(scope)) rememberCovers([cached]);
  }
}

async function syncCovers(data, retry = false) {
  const account = window.ReaderAccount.current;
  if (!state.accountReady || account?.mode !== "cloud" || !state.offlineReady || state.coverSync) return;
  const scope = account.scope;
  const books = data.books.filter((book) => {
    if (data.coverDeviceId && book.sourceDeviceId !== data.coverDeviceId) return false;
    const cached = state.covers.get(book.id);
    return !cached?.cover && (retry || !cached || cached.availableOnMac !== book.availableOnMac
      || Date.now() - Date.parse(cached.checkedAt) > 6 * 60 * 60 * 1000);
  });
  if (!books.length) { coverStatus(""); return; }
  if (!data.coversReady) {
    coverStatus("Connect to your Mac on the same Wi-Fi to load missing covers.");
    return;
  }
  if (!retry && Date.now() - state.coverAttemptedAt < 5 * 60 * 1000) return;
  state.coverAttemptedAt = Date.now();
  const controller = new AbortController();
  state.coverSync = controller;
  coverStatus("Loading covers from your Mac…");
  try {
    for (let offset = 0; offset < books.length; offset += 200) {
      const batch = books.slice(offset, offset + 200);
      const bookIds = batch.map((book) => book.id);
      const available = new Map(batch.map((book) => [book.id, book.availableOnMac]));
      await window.BookTransfer.receive({
        kind: "covers", bookId: bookIds[0], bookIds, signal: controller.signal,
        request: (path, options = {}) => {
          if (!sameAccount(scope)) throw new Error("Your account changed.");
          const body = options.body;
          return api(path, { ...options, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
        },
        save: async (blob) => {
          const records = await window.BookCovers.readBundle(blob, bookIds);
          controller.signal.throwIfAborted();
          if (!sameAccount(scope)) throw new Error("Your account changed.");
          for (const record of records) record.availableOnMac = available.get(record.id);
          await OfflineBooks.putCovers(records, scope);
          if (sameAccount(scope) && !controller.signal.aborted) rememberCovers(records);
          return records;
        },
      });
    }
    if (sameAccount(scope)) coverStatus("");
  } catch (error) {
    if (sameAccount(scope)) {
      if (error.name === "AbortError") coverStatus("");
      else coverStatus(error.name === "QuotaExceededError" ? "There isn’t enough space on this device to save covers."
        : "Covers couldn’t load. Keep your Mac on the same Wi-Fi, then tap Refresh library to retry.");
    }
  } finally {
    if (state.coverSync === controller) state.coverSync = null;
  }
}

function canDownload(book) {
  return state.bridgeOnline && (book.readable || window.ReaderAccount.current?.mode === "cloud" && book.availableOnMac);
}

function bookButton(book, continuing = false) {
  const button = element("button", continuing ? "continue-book" : "book-card");
  button.type = "button";
  const saved = state.savedBooks.has(book.id);
  const readable = saved || state.bridgeOnline && book.readable;
  const downloadable = !saved && state.offlineReady && canDownload(book);
  button.disabled = !(readable || downloadable) || state.downloads.has(book.id);
  button.setAttribute("aria-label", `${readable ? "Read" : downloadable ? "Save and read:" : "Unavailable:"} ${book.title}`);
  button.append(coverFor(book));
  const info = element("div", "book-info");
  info.append(element("h3", "", book.title), element("p", "book-author", book.author || "Unknown author"));
  if (readable) {
    const meta = bookMeta(book);
    if (meta) info.append(meta);
    if (readBackup(book.id)) info.append(element("p", "pending-label", "Position saved on this device"));
    else if (book.syncState === "pending") info.append(element("p", "pending-label", "New web position saved"));
    else if (book.syncState === "conflict") info.append(element("p", "pending-label", "Choose your reading position"));
    if (continuing) info.append(element("p", "read-label", "Continue reading"));
  } else {
    info.append(element("p", "book-availability", !state.bridgeOnline ? "Not saved on this device" : downloadable ? "Save from your Mac to read here" : window.ReaderAccount.current?.mode === "cloud" ? "Download this EPUB in Apple Books on your Mac first." : book.unavailableReason || "Download this EPUB in Apple Books first."));
  }
  if (saved) info.append(element("p", "offline-badge", "✓ Saved on this device"));
  button.append(info);
  button.addEventListener("click", async () => {
    if (!readable && downloadable) {
      if (await toggleDownload(book)) await openBook(book.id);
    } else await openBook(book.id);
  });
  return button;
}

function shelfItem(book) {
  const item = element("div", "shelf-item");
  item.append(bookButton(book));
  const saved = state.savedBooks.has(book.id), download = state.downloads.get(book.id);
  const action = element("button", "download-button", download ? download.saving ? "Saving on this device…" : "Cancel download" : saved ? "Remove download" : "Save offline");
  action.type = "button";
  action.id = `download-action-${book.id}`;
  action.dataset.state = download ? "busy" : saved ? "saved" : "save";
  action.disabled = download?.saving || !download && (!state.offlineReady || !saved && !canDownload(book));
  action.setAttribute("aria-label", `${download ? "Cancel download of" : saved ? "Remove download of" : "Save offline:"} ${book.title}`);
  action.addEventListener("click", () => download ? download.controller.abort() : toggleDownload(book));
  item.append(action);
  if (download) {
    const progress = element("p", "download-progress", download.message);
    progress.id = `download-status-${book.id}`;
    progress.setAttribute("role", "status");
    item.append(progress);
  }
  return item;
}

function bytesLabel(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function updateOfflineStatus() {
  if (!state.offlineReady) return;
  const records = [...state.savedBooks.values()];
  const bytes = records.reduce((total, book) => total + book.bytes, 0);
  el("offline-status").textContent = records.length ? `${records.length} saved · ${bytesLabel(bytes)} on this device` : "No books saved yet";
}

async function loadSavedBooks() {
  const scope = window.ReaderAccount.current?.scope;
  const [records, covers] = await Promise.all([OfflineBooks.list(), OfflineBooks.listCovers()]);
  if (!sameAccount(scope)) return;
  rememberCovers(covers);
  state.savedBooks = new Map(records.map((record) => [record.id, { id: record.id, detail: record.detail, bytes: record.bytes }]));
  state.offlineReady = true;
  updateOfflineStatus();
  backfillCovers(records, scope).catch(() => {});
}

async function toggleDownload(book) {
  if (!state.accountReady || state.downloads.has(book.id)) return false;
  const scope = window.ReaderAccount.current.scope;
  const controller = new AbortController();
  const download = { controller, message: "Preparing download…" };
  state.downloads.set(book.id, download);
  renderLibrary();
  showError("library-error", "");
  function checkAccount() {
    if (!state.accountReady || window.ReaderAccount.current?.scope !== scope) throw new Error("Your account changed. Reopen your library before saving books.");
    controller.signal.throwIfAborted();
  }
  function progress(value) {
    const percentage = value.total ? Math.min(100, Math.round(value.received / value.total * 100)) : 0;
    const labels = {
      connecting: "Connecting to your Mac…",
      receiving: `Copying from Mac · ${percentage}%`,
      verifying: "Checking your book…",
      saving: "Saving on this device…",
    };
    download.message = labels[value.phase] || "Saving…";
    download.saving = value.phase === "saving";
    const action = el(`download-action-${book.id}`);
    if (action && download.saving) { action.disabled = true; action.textContent = "Saving on this device…"; }
    const label = el(`download-status-${book.id}`);
    if (label && label.textContent !== download.message) label.textContent = download.message;
  }
  try {
    if (state.syncingBackups) await state.syncingBackups;
    checkAccount();
    if (state.savedBooks.has(book.id)) {
      await OfflineBooks.remove(book.id);
    } else {
      await OfflineBooks.prepareShell();
      checkAccount();
      const detail = await api(`/api/books/${encodeURIComponent(book.id)}`);
      checkAccount();
      async function save(epub, cover = null) {
        checkAccount();
        const record = { id: book.id, detail, epub, cover, bytes: epub.size + (cover?.size || 0), savedAt: new Date().toISOString() };
        await OfflineBooks.put(record, scope);
        return record;
      }
      if (window.ReaderAccount.current.mode === "cloud") {
        if (!detail.availableOnMac) throw new Error("Download this EPUB in Apple Books on your Mac, then sync and try again.");
        await window.BookTransfer.receive({
          bookId: book.id, signal: controller.signal, onProgress: progress, save,
          request: (path, options = {}) => {
            // Cancellation must still be able to delete connection metadata.
            if (!state.accountReady || window.ReaderAccount.current?.scope !== scope) throw new Error("Your account changed.");
            const body = options.body;
            return api(path, { ...options, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
          },
        });
      } else {
        if (!detail.readable) throw new Error(detail.unavailableReason || "Download the EPUB in Apple Books first.");
        const response = await fetch(detail.epubUrl, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("The book could not be copied from your Mac. Please try again.");
        const epub = await response.blob();
        if (!epub.size) throw new Error("The downloaded book was empty. Please try again.");
        let cover = null;
        if (detail.coverUrl) {
          try {
            const result = await fetch(detail.coverUrl, { cache: "no-store", signal: controller.signal });
            if (result.ok) cover = await result.blob();
          } catch { /* A missing cover does not prevent offline reading. */ }
        }
        await save(epub, cover);
      }
      // Browsers may decline persistence. Never imply a permanent storage guarantee.
      navigator.storage?.persist?.().catch(() => {});
    }
    if (state.accountReady && window.ReaderAccount.current?.scope === scope) await loadSavedBooks();
    return true;
  } catch (error) {
    if (error.name === "AbortError" && state.accountReady && window.ReaderAccount.current?.scope === scope) {
      // A cancelled transfer may already have started its atomic IDB commit.
      // This read queues behind the write so a saved copy is never hidden.
      await loadSavedBooks().catch(() => {});
    }
    if (error.name !== "AbortError" && state.accountReady && window.ReaderAccount.current?.scope === scope) {
      showError("library-error", error.name === "QuotaExceededError"
        ? "There isn’t enough space on this device. Remove a download and try again."
        : `Couldn’t change the download for “${book.title}”. ${error.message}`);
    }
    return false;
  } finally {
    state.downloads.delete(book.id);
    if (state.accountReady && window.ReaderAccount.current?.scope === scope) renderLibrary();
  }
}

function renderLibrary() {
  const query = el("search").value.trim().toLocaleLowerCase();
  const filtered = state.books.filter((book) => {
    const matches = `${book.title} ${book.author || ""}`.toLocaleLowerCase().includes(query);
    return matches && (state.filter !== "reading" || book.progress > 0 && book.progress < .99 || book.syncState === "pending")
      && (state.filter !== "available" || (book.availableOnMac ?? book.readable))
      && (state.filter !== "saved" || state.savedBooks.has(book.id));
  });
  el("book-count").textContent = state.books.length;
  el("shelf").replaceChildren(...filtered.map(shelfItem));
  el("empty-library").hidden = filtered.length > 0;
  el("empty-library").textContent = state.filter === "saved" && !state.savedBooks.size ? "Choose Save offline on a book while connected. It will appear here for your next trip." : state.books.length ? "No books match. Try another title or filter." : window.ReaderAccount.current?.mode === "cloud" ? "Link your Mac to add your books." : "Your library is empty. Add an EPUB to Apple Books on this Mac, then refresh.";
  const continuing = state.books.filter((book) => (state.savedBooks.has(book.id) || state.bridgeOnline && book.readable) && (book.progress > 0 && book.progress < .99 || book.syncState === "pending" || readBackup(book.id))).slice(0, 3);
  el("continue-section").hidden = continuing.length === 0 || !!query || state.filter !== "all";
  el("continue-books").replaceChildren(...continuing.map((book) => bookButton(book, true)));
}

async function refreshLibrary({ retryCovers = false } = {}) {
  if (!state.accountReady) return;
  const request = ++state.libraryRequest;
  el("refresh").disabled = true;
  el("library-status").textContent = "Checking your Apple Books library…";
  try {
    const data = await api("/api/library");
    if (!state.accountReady || request !== state.libraryRequest) return;
    state.bridgeOnline = true;
    state.books = data.books;
    for (const saved of state.savedBooks.values()) if (!state.books.some((book) => book.id === saved.id)) state.books.push(saved.detail);
    OfflineBooks.saveLibrary(state.books).catch(() => {});
    renderLibrary();
    const readable = data.books.filter((book) => book.readable).length;
    el("library-status").textContent = window.ReaderAccount.current?.mode === "cloud"
      ? `${data.books.length} books in your private library. ${data.transferReady ? "Your Mac is ready to send books." : "Start transfers on your Mac to save books here."}`
      : `${readable} available on Mac. Updated from Apple Books just now.`;
    showError("library-error", "");
    syncBackups().catch(() => {});
    syncCovers(data, retryCovers).catch(() => {});
  } catch (error) {
    if (request !== state.libraryRequest) return;
    if (error.status === 401 || error.status === 403) return;
    state.bridgeOnline = false;
    if (!state.books.length) {
      try { state.books = await OfflineBooks.readLibrary() || []; } catch { /* Saved books can still supply the shelf. */ }
    }
    for (const saved of state.savedBooks.values()) if (!state.books.some((book) => book.id === saved.id)) state.books.push(saved.detail);
    renderLibrary();
    const cloud = window.ReaderAccount.current?.mode === "cloud";
    el("library-status").textContent = cloud ? "Sync unavailable. Your saved books are ready here." : "Mac disconnected. Your saved books are ready here.";
    showError("library-error", state.savedBooks.size ? "" : cloud ? "Reconnect to refresh your private library." : "Connect to your Mac and save a book before reading offline.");
  } finally {
    if (request === state.libraryRequest) el("refresh").disabled = false;
  }
}

function timestamp(value) {
  if (!value) return "No recorded time";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Saved position" : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function choosePosition(detail, backup) {
  return new Promise((resolve) => {
    const dialog = el("position-dialog");
    el("position-description").textContent = `There are different saved positions for “${detail.title}”. Choose the one you want to continue from.`;
    const choices = [];
    function choice(source, label, time) {
      const button = element("button", "position-choice");
      button.type = "button";
      button.append(element("strong", "", label), element("span", "", timestamp(time)));
      button.addEventListener("click", () => dialog.close(source));
      choices.push(button);
    }
    if (backup) choice("local", "Use this device’s unsent position", backup.savedLocallyAt);
    if (detail.webPosition) choice("web", "Use the saved web position", detail.webPosition.savedAt);
    if (detail.applePosition) choice("apple", "Use the Apple Books position", detail.applePosition.updatedAt);
    el("position-choices").replaceChildren(...choices);
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "cancel" || !dialog.returnValue ? null : dialog.returnValue), { once: true });
    dialog.returnValue = "cancel";
    dialog.showModal();
  });
}

async function resolvePosition(detail, memoryBackup = null) {
  let backup = memoryBackup || readBackup(detail.id);
  const web = detail.webPosition;
  if (backup && (backup.cfi === web?.cfi || backup.clientId === web?.clientId && backup.sequence <= web.sequence)) {
    // sendDraft removes the durable backup only after updating the offline copy.
    backup = null;
  }
  const localConflict = backup && (backup.appleRevision !== (detail.applePosition?.revision || null)
    || web && backup.clientId !== web.clientId && backup.baseRevision !== web.revision);
  if (detail.syncState === "conflict" || localConflict) {
    const source = await choosePosition(detail, backup);
    if (!source) return null;
    const selected = source === "local" ? backup : source === "web" ? web : detail.applePosition;
    return { cfi: selected.cfi, source, saveChoice: true };
  }
  if (backup) return { cfi: backup.cfi, source: "local", saveChoice: true };
  return { cfi: detail.resume?.cfi || undefined, source: detail.resume?.source || "start", saveChoice: false };
}

function status(message, detail) {
  el("reader-status").textContent = message;
  if (detail) el("save-detail").textContent = detail;
}

function updateReturnLink(cfi) {
  const url = state.detail?.appleBooksUrl;
  el("open-apple").hidden = !url || !cfi;
  if (url && cfi) el("open-apple").href = `${url}#${cfi}`;
}

function updateLocation(location) {
  if (!location?.start) return;
  state.location = location;
  state.currentCfi = location.start.cfi;
  updateReturnLink(state.currentCfi);
  const href = location.start.href;
  const chapter = state.epub.navigation.get(href) || state.epub.navigation.get(href?.split("#")[0]);
  const section = location.start.index + 1;
  const label = chapter?.label?.trim() || `Section ${section}`;
  const displayed = location.start.displayed;
  el("chapter-label").textContent = displayed ? `${label} • ${displayed.page} of ${displayed.total}` : label;
  el("previous").disabled = !state.ready || location.atStart;
  el("next").disabled = !state.ready || location.atEnd;
}

function markDraft(cfi, href) {
  const draft = {
    id: state.detail.id, cfi, href,
    clientId, sequence: ++state.sequence,
    baseRevision: state.detail.webPosition?.revision || 0,
    appleRevision: state.detail.applePosition?.revision || null,
    savedLocallyAt: new Date().toISOString(),
  };
  state.draft = draft;
  storeBackup(draft);
  status(state.bridgeOnline ? "Saving your reading position…" : state.storageWarning ? "Position not saved" : "Saved on this device", state.bridgeOnline ? "Your position will wait for a handoff to Apple Books." : "Your position will sync when you reconnect to your Mac.");
  el("retry-save").hidden = state.bridgeOnline;
  return draft;
}

async function sendDraft(draft, keepalive = false) {
  const { id, savedLocallyAt, ...payload } = draft;
  const result = await api(`/api/books/${encodeURIComponent(id)}/position`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload), keepalive,
  });
  if (result.position.cfi !== draft.cfi && state.draft?.sequence === draft.sequence && state.draft?.clientId === draft.clientId) {
    const error = new Error("A newer reading position was saved elsewhere.");
    error.status = 409;
    throw error;
  }
  let cachedDurably = true;
  const cached = state.savedBooks.get(id);
  if (cached && result.position.revision >= (cached.detail.webPosition?.revision || 0)) {
    cached.detail = { ...cached.detail, webPosition: result.position, syncState: "pending", resume: { cfi: result.position.cfi, source: "web" } };
    try { await OfflineBooks.updateDetail(cached.detail); }
    catch { cachedDurably = false; }
  }
  // A server acknowledgement alone is insufficient for the next offline open.
  if (cachedDurably) removeBackup(draft);
  if (state.detail?.id === id) {
    if (result.position.revision >= (state.detail.webPosition?.revision || 0)) state.detail.webPosition = result.position;
    state.detail.syncState = "pending";
    if (state.draft?.sequence === draft.sequence && state.draft?.clientId === draft.clientId) {
      state.draft = null;
      status("Saved in web reader", "Waiting for Apple Books. Open this position on your Mac to hand it back.");
      el("retry-save").hidden = true;
      if (!state.storageWarning) showError("reader-error", "");
    }
  }
}

function saveDraft(draft = state.draft) {
  if (!draft) return state.saveQueue;
  if (!state.bridgeOnline && !state.storageWarning) return Promise.resolve();
  state.saveQueue = state.saveQueue.catch(() => {}).then(() => sendDraft(draft)).catch((error) => {
    if (state.detail?.id === draft.id) {
      if (!error.status) state.bridgeOnline = false;
      status(state.storageWarning ? "Position not saved" : "Saved on this device", "Your position will sync when you reconnect to your Mac.");
      el("retry-save").hidden = false;
      showError("reader-error", error.status === 409
        ? "Another reading position changed. Choose where to continue before saving again."
        : `Couldn’t send your reading position. ${error.message}`);
    }
    throw error;
  });
  return state.saveQueue;
}

function syncBackups() {
  if (state.syncingBackups) return state.syncingBackups;
  if (!state.bridgeOnline) return Promise.resolve();
  const operation = sendBackups();
  state.syncingBackups = operation;
  return operation.finally(() => { state.syncingBackups = false; });
}

async function sendBackups() {
  try {
    for (const book of state.books) {
      if (state.detail?.id === book.id || state.downloads.has(book.id)) continue;
      const backup = readBackup(book.id);
      if (!backup) continue;
      try {
        // Keep the revision captured offline. The server rejects conflicts;
        // opening that book will let the reader choose which position to keep.
        await sendDraft(backup);
        book.syncState = "pending";
      } catch (error) {
        if (error.status === 409) book.syncState = "conflict";
        else { state.bridgeOnline = false; break; }
      }
    }
  } finally {
    if (!state.detail) renderLibrary();
  }
}

async function navigate(action) {
  if (!state.ready || state.navigation) return;
  const rendition = state.rendition;
  const before = state.currentCfi;
  const operation = (async () => {
    await action();
    // EPUB.js reports its new location on the next animation frame.
    await rendition.reportLocation();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (state.rendition !== rendition || !state.currentCfi || before === state.currentCfi) return;
    state.anchorCfi = state.currentCfi;
    const draft = markDraft(state.currentCfi, state.location?.start.href);
    saveDraft(draft).catch(() => {});
  })();
  state.navigation = operation;
  try { await operation; }
  catch (error) { showError("reader-error", `Couldn’t turn to that page. ${error.message}`); }
  finally { if (state.navigation === operation) state.navigation = null; }
}

function keyNavigation(event) {
  if (event.key === "Escape" && !el("settings-panel").hidden) { closeSettings(true); return; }
  if (!state.ready || event.altKey || event.ctrlKey || event.metaKey || /INPUT|TEXTAREA|SELECT/.test(event.target?.tagName)) return;
  if (event.key === "ArrowRight") { event.preventDefault(); navigate(() => turnPage(1)); }
  if (event.key === "ArrowLeft") { event.preventDefault(); navigate(() => turnPage(-1)); }
}

function activeTheme() {
  return readerSettings.theme || (darkScheme.matches ? "night" : "white");
}

function readerCss() {
  const theme = readerThemes[activeTheme()];
  const font = readerFonts[readerSettings.font];
  const base = matchMedia("(max-width:600px)").matches ? 110 : 115;
  const fontRule = font ? `font-family: ${font} !important;` : "";
  // Book stylesheets often hard-code black text or coloured boxes, which would
  // vanish or clash on other themes, so text and boxes follow the theme.
  return `
html, body { background: ${theme.bg} !important; color: ${theme.fg} !important; }
body { font-size: ${Math.round(base * readerSettings.size / 100)}% !important; line-height: 1.65 !important; ${fontRule} }
p { line-height: 1.65 !important; }
body *:not(a) { color: inherit !important; }
body * { background-color: transparent !important; }
a { color: ${theme.link} !important; }
${font ? `p, div, span, li, blockquote, dd, dt, td, th, h1, h2, h3, h4, h5, h6 { ${fontRule} }` : ""}`;
}

function styleContents(contents) {
  contents.addStylesheetCss(readerCss(), "reader-settings");
}

function syncThemeColor(color) {
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.dataset.libraryColor ??= meta.content;
    meta.content = color || meta.dataset.libraryColor;
  }
}

function renderSettings() {
  const theme = activeTheme();
  el("reading-view").dataset.theme = theme;
  for (const input of document.querySelectorAll('input[name="reader-theme"]')) input.checked = input.value === theme;
  for (const input of document.querySelectorAll('input[name="reader-font"]')) input.checked = input.value === readerSettings.font;
  el("text-size").textContent = `${readerSettings.size}%`;
  el("smaller-text").disabled = readerSettings.size === textSizes[0];
  el("larger-text").disabled = readerSettings.size === textSizes.at(-1);
  if (!el("reading-view").hidden) syncThemeColor(readerThemes[theme].bg);
}

let relayoutTimer = null;
function applySettings({ reflow = false } = {}) {
  try { localStorage.setItem(settingsKey, JSON.stringify(readerSettings)); } catch { /* Settings still apply to this visit. */ }
  renderSettings();
  if (!state.rendition) return;
  for (const contents of state.rendition.getContents()) styleContents(contents);
  if (reflow) {
    // Rapid taps on the size buttons settle into one repagination.
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(relayout, 200);
  }
}

async function relayout() {
  const rendition = state.rendition;
  if (!state.ready || !rendition) return;
  while (state.navigation) await state.navigation.catch(() => {});
  const target = state.anchorCfi || state.currentCfi;
  if (state.rendition !== rendition || !state.ready || !target) return;
  // Return to the passage the reader was on before the text reflowed.
  // This is not a page turn, so it does not record a new reading position.
  const operation = displayPosition(target).catch(() => {});
  state.navigation = operation;
  try { await operation; }
  finally { if (state.navigation === operation) state.navigation = null; }
}

function openSettings() {
  renderSettings();
  el("settings-panel").hidden = false;
  el("show-settings").setAttribute("aria-expanded", "true");
  if (matchMedia("(max-width: 900px)").matches) closeNotes();
  (document.querySelector('input[name="reader-theme"]:checked') || el("smaller-text")).focus({ preventScroll: true });
}

function closeSettings(returnFocus = false) {
  if (el("settings-panel").hidden) return;
  el("settings-panel").hidden = true;
  el("show-settings").setAttribute("aria-expanded", "false");
  if (returnFocus) el("show-settings").focus({ preventScroll: true });
}

function changeTextSize(step) {
  const index = textSizes.indexOf(readerSettings.size) + step;
  if (index < 0 || index >= textSizes.length) return;
  readerSettings.size = textSizes[index];
  applySettings({ reflow: true });
}

function showNotes(annotationId) {
  el("notes-panel").hidden = false;
  el("show-notes").setAttribute("aria-expanded", "true");
  for (const item of el("annotations").children) item.classList.toggle("selected", item.dataset.annotationId === String(annotationId));
  const selected = [...el("annotations").children].find((item) => item.dataset.annotationId === String(annotationId));
  selected?.scrollIntoView({ block: "nearest" });
}

function closeNotes() {
  el("notes-panel").hidden = true;
  el("show-notes").setAttribute("aria-expanded", "false");
}

async function importAnnotations(detail) {
  const annotations = detail.annotations || [];
  el("note-count").textContent = annotations.length || "";
  const items = await Promise.all(annotations.map(async (annotation) => {
    const button = element("button", "annotation");
    button.type = "button";
    button.dataset.annotationId = annotation.id;
    button.style.borderLeftColor = annotation.color || "#d6b852";
    button.append(element("span", "annotation-type", annotation.type === "bookmark" ? "Bookmark" : "Highlight"));
    button.append(element("span", "annotation-text", annotation.text || (annotation.type === "bookmark" ? "Saved passage" : "Highlighted passage")));
    if (annotation.note) button.append(element("span", "annotation-note", annotation.note));
    button.disabled = !annotation.cfi;
    button.addEventListener("click", () => {
      if (matchMedia("(max-width: 900px)").matches) closeNotes();
      navigate(() => displayPosition(annotation.cfi));
    });
    if (annotation.cfi) {
      try {
        const range = await state.epub.getRange(annotation.cfi);
        if (!range) throw new Error("Missing passage");
        if (annotation.type === "highlight") state.rendition.annotations.highlight(annotation.cfi, {}, () => showNotes(annotation.id), "apple-highlight", { fill: annotation.color || "#efd263", "fill-opacity": "0.32", "mix-blend-mode": "multiply" });
        else state.rendition.annotations.mark(annotation.cfi, {}, () => showNotes(annotation.id));
      } catch {
        button.append(element("span", "annotation-note", "This mark could not be placed on the page."));
      }
    }
    return button;
  }));
  el("annotations").replaceChildren(...items);
  if (!items.length) el("annotations").append(element("p", "notes-empty", "No highlights or bookmarks from Apple Books in this book yet."));
}

async function displayPosition(target) {
  const rendition = state.rendition;
  const section = state.epub.spine.get(target);
  // EPUB.js Views.find() takes a section, not a callback, so search the
  // displayed views directly. Waiting for "rendered" on a section that is
  // already on screen would never resolve and lock navigation.
  let view = section && (rendition.views().displayed?.() || []).find((item) => item.section.index === section.index);
  if (view) {
    await rendition.display(target);
  } else {
    let onRendered, onError;
    const rendered = new Promise((resolve, reject) => {
      onRendered = (renderedSection, renderedView) => {
        if (!section || renderedSection.index === section.index) resolve(renderedView);
      };
      onError = reject;
      rendition.on("rendered", onRendered);
      rendition.on("displayError", onError);
    });
    try {
      [view] = await Promise.all([rendered, rendition.display(target)]);
    } finally {
      rendition.off("rendered", onRendered);
      rendition.off("displayError", onError);
    }
  }
  // EPUB.js resolves display before content hooks apply the reader theme.
  // Wait for that hook and its fonts, then recalculate the target's page.
  if (view.document.fonts) await view.document.fonts.ready;
  view.setLayout(view.layout);
  await rendition.display(target);
  const point = target?.startsWith("epubcfi(") ? new ePub.CFI(target) : null;
  point?.collapse(true);
  // A target near a column boundary can still land one page away after reflow.
  // Verify its actual visible range and correct only a bounded number of pages.
  for (let correction = 0; correction <= 3; correction++) {
    await rendition.reportLocation();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!point) return;
    const location = state.location;
    if (!location?.start || !location?.end) break;
    const before = point.compare(point, location.start.cfi) < 0;
    const after = point.compare(point, location.end.cfi) > 0;
    if (!before && !after) return;
    if (correction === 3 || before && location.atStart || after && location.atEnd) break;
    if (before) await rendition.prev();
    else await rendition.next();
  }
  throw new Error("The saved passage could not be placed on the visible page.");
}

async function turnPage(direction) {
  const location = state.location;
  if (direction > 0 && location?.end.displayed?.page === location?.end.displayed?.total) {
    const next = state.epub.spine.get(location.end.index)?.next();
    if (next) return displayPosition(next.href);
  }
  if (direction < 0 && location?.start.displayed?.page === 1) {
    const previous = state.epub.spine.get(location.start.index)?.prev();
    if (previous) {
      await previous.load(state.epub.load.bind(state.epub));
      const document = previous.document;
      const body = document.querySelector("body");
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let lastText, node;
      while ((node = walker.nextNode())) {
        if (node.textContent.trim() && !node.parentElement.closest("script, style")) lastText = node;
      }
      if (lastText) {
        const range = document.createRange();
        range.setStart(lastText, Math.max(0, lastText.textContent.trimEnd().length - 1));
        range.collapse(true);
        return displayPosition(previous.cfiFromRange(range));
      }
      return displayPosition(previous.href);
    }
  }
  return direction > 0 ? state.rendition.next() : state.rendition.prev();
}

async function openBook(id) {
  if (!state.accountReady || state.opening) return;
  state.opening = true;
  showError("library-error", "");
  try {
    if (state.syncingBackups) await state.syncingBackups;
    let saved;
    try { saved = await OfflineBooks.get(id); } catch { /* Online reading can continue without device storage. */ }
    let detail;
    try {
      if (!navigator.onLine || !state.bridgeOnline) throw new Error("Mac disconnected");
      detail = await api(`/api/books/${encodeURIComponent(id)}`);
      state.bridgeOnline = true;
    } catch (error) {
      if (!saved || error.status && ![404, 503].includes(error.status)) throw error;
      state.bridgeOnline = false;
      detail = saved.detail;
    }
    if (saved && state.bridgeOnline) {
      saved.detail = detail;
      const cached = state.savedBooks.get(id);
      if (cached) cached.detail = detail;
      await OfflineBooks.updateDetail(detail).catch(() => {});
    }
    if (!saved && !detail.readable) throw new Error(detail.unavailableReason || "This EPUB is not available on your Mac.");
    const position = await resolvePosition(detail);
    if (!position) return;
    state.detail = detail;
    state.draft = null;
    state.ready = false;
    state.currentCfi = null;
    state.location = null;
    state.saveQueue = Promise.resolve();
    el("library-view").hidden = true;
    el("reading-view").hidden = false;
    renderSettings();
    el("reader-loading").hidden = false;
    el("book-title").textContent = detail.title;
    el("book-author").textContent = detail.author || "";
    el("note-count").textContent = "";
    el("annotations").replaceChildren();
    el("chapter-label").textContent = "Loading chapter…";
    document.title = `${detail.title} — Your library`;
    el("done-reading").disabled = true;
    el("previous").disabled = true;
    el("next").disabled = true;
    el("retry-save").hidden = true;
    showError("reader-error", "");
    status("Opening your book…", detail.syncState === "pending"
      ? "Waiting for Apple Books. Open this position on your Mac to hand it back."
      : "Your progress saves as you turn pages.");
    updateReturnLink(position.cfi);
    window.scrollTo(0, 0);
    closeNotes();
    state.epub = ePub();
    await state.epub.open(saved ? await saved.epub.arrayBuffer() : detail.epubUrl, saved ? "binary" : "epub");
    state.rendition = state.epub.renderTo("reader", { width: "100%", height: "100%", flow: "paginated", spread: "none", allowScriptedContent: false, allowPopups: false });
    state.rendition.on("relocated", updateLocation);
    state.rendition.on("displayError", (error) => showError("reader-error", `Couldn’t display this passage. ${error.message || error}`));
    state.rendition.on("keydown", keyNavigation);
    state.rendition.hooks.content.register((contents) => {
      styleContents(contents);
      // Taps inside the page never reach the outer document.
      contents.document.addEventListener("pointerdown", () => closeSettings(), { passive: true });
      // EPUB.js has already queued internal-link navigation when this event fires.
      contents.on("linkClicked", (href) => navigate(() => displayPosition(state.epub.path.relative(href))));
      let touchStart;
      contents.document.addEventListener("touchstart", (event) => { const touch = event.changedTouches[0]; touchStart = { x: touch.clientX, y: touch.clientY }; }, { passive: true });
      contents.document.addEventListener("touchend", (event) => {
        if (!touchStart || contents.window.getSelection()?.toString()) return;
        const touch = event.changedTouches[0];
        const dx = touch.clientX - touchStart.x, dy = touch.clientY - touchStart.y;
        touchStart = null;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) navigate(() => turnPage(dx < 0 ? 1 : -1));
      }, { passive: true });
    });
    await state.epub.ready;
    await importAnnotations(detail);
    await displayPosition(position.cfi);
    state.anchorCfi = position.cfi || state.currentCfi;
    state.ready = true;
    el("reader-loading").hidden = true;
    el("done-reading").disabled = false;
    if (state.location) updateLocation(state.location);
    status(!state.bridgeOnline ? "Reading your saved copy" : position.source === "apple" ? "Opened at your Apple Books position" : position.source === "start" ? "Ready to read" : "Resumed your web reading position",
      !state.bridgeOnline ? "Your position stays on this device until you reconnect." : detail.syncState === "pending" ? "Waiting for Apple Books. Open this position on your Mac to hand it back." : "Your progress saves as you turn pages.");
    if (position.saveChoice) saveDraft(markDraft(position.cfi, state.location?.start.href)).catch(() => {});
  } catch (error) {
    if (state.detail) {
      el("reader-loading").hidden = true;
      showError("reader-error", `Couldn’t open this book. ${error.message}`);
      status("Book unavailable", "Return to your library and try another book.");
    } else showError("library-error", error.message);
  } finally { state.opening = false; }
}

function disposeReader() {
  state.ready = false;
  clearTimeout(relayoutTimer);
  closeSettings();
  state.rendition?.destroy();
  state.epub?.destroy();
  state.rendition = null; state.epub = null; state.detail = null;
  state.currentCfi = null; state.location = null; state.draft = null; state.anchorCfi = null;
  el("reader").replaceChildren();
  el("reading-view").hidden = true;
  el("library-view").hidden = false;
  syncThemeColor(null);
  document.title = "Your library";
}

async function finishReading() {
  if (state.opening) return;
  el("done-reading").disabled = true;
  try {
    if (state.navigation) await state.navigation;
    if (state.draft) {
      try { await saveDraft(); }
      catch (error) {
        // It is safe to leave offline once the exact pending position is durable.
        const backup = readBackup(state.draft.id);
        if (state.storageWarning || backup?.clientId !== state.draft.clientId || backup?.sequence !== state.draft.sequence || error.status === 409) throw error;
      }
      if (state.draft) {
        const backup = readBackup(state.draft.id);
        if (backup?.clientId !== state.draft.clientId || backup?.sequence !== state.draft.sequence) throw new Error("Your position has not been saved on this device.");
      }
    }
    else await state.saveQueue.catch(() => {});
    disposeReader();
    await refreshLibrary();
    el("shelf-heading").focus({ preventScroll: true });
  } catch {
    // Keep the reader and local backup intact until the user retries.
    el("done-reading").disabled = false;
  }
}

function flushOnHide() {
  if (!state.accountReady) return;
  const draft = state.draft;
  if (!draft) return;
  storeBackup(draft);
  // The server rejects old sequence numbers, including late keepalive requests.
  sendDraft(draft, true).catch(() => {});
}

async function retrySave() {
  if (!state.detail || !state.draft) return;
  const detail = await api(`/api/books/${encodeURIComponent(state.detail.id)}`);
  state.bridgeOnline = true;
  const cached = state.savedBooks.get(detail.id);
  if (cached) cached.detail = detail;
  const position = await resolvePosition(detail, state.draft);
  if (!position) return;
  state.detail = detail;
  if (position.cfi && position.cfi !== state.currentCfi) {
    await displayPosition(position.cfi);
    state.anchorCfi = position.cfi;
  }
  await saveDraft(markDraft(position.cfi || state.currentCfi, state.location?.start.href));
}

el("search").addEventListener("input", renderLibrary);
for (const button of document.querySelectorAll("[data-filter]")) button.addEventListener("click", () => {
  state.filter = button.dataset.filter;
  for (const item of document.querySelectorAll("[data-filter]")) item.setAttribute("aria-pressed", String(item === button));
  renderLibrary();
});
el("refresh").addEventListener("click", () => refreshLibrary({ retryCovers: true }));
el("previous").addEventListener("click", () => navigate(() => turnPage(-1)));
el("next").addEventListener("click", () => navigate(() => turnPage(1)));
el("back-library").addEventListener("click", finishReading);
el("done-reading").addEventListener("click", finishReading);
el("show-notes").addEventListener("click", () => {
  if (!el("notes-panel").hidden) return closeNotes();
  if (matchMedia("(max-width: 900px)").matches) closeSettings();
  showNotes();
});
el("close-notes").addEventListener("click", closeNotes);
el("show-settings").addEventListener("click", () => el("settings-panel").hidden ? openSettings() : closeSettings(true));
el("smaller-text").addEventListener("click", () => changeTextSize(-1));
el("larger-text").addEventListener("click", () => changeTextSize(1));
for (const input of document.querySelectorAll('input[name="reader-theme"]')) input.addEventListener("change", () => {
  readerSettings.theme = input.value;
  applySettings();
});
for (const input of document.querySelectorAll('input[name="reader-font"]')) input.addEventListener("change", () => {
  readerSettings.font = input.value;
  applySettings({ reflow: true });
});
darkScheme.addEventListener("change", () => { if (!readerSettings.theme) applySettings(); });
document.addEventListener("pointerdown", (event) => {
  if (!el("settings-panel").hidden && !event.target.closest("#settings-panel, #show-settings")) closeSettings();
});
el("retry-save").addEventListener("click", () => retrySave().catch((error) => showError("reader-error", error.message)));
document.addEventListener("keydown", keyNavigation);
document.addEventListener("visibilitychange", () => {
  if (!state.accountReady) return;
  if (document.visibilityState === "hidden") flushOnHide();
  else if (!state.detail && !state.opening) refreshLibrary();
});
window.addEventListener("pagehide", () => { flushOnHide(); cancelDownloads(); });
function cancelDownloads() {
  for (const download of state.downloads.values()) download.controller.abort();
  state.coverSync?.abort();
}
window.addEventListener("books-session-expired", cancelDownloads);
window.addEventListener("books-account-changing", () => {
  cancelDownloads();
  state.accountReady = false;
  state.ready = false;
  state.libraryRequest++;
  for (const url of state.coverUrls.values()) URL.revokeObjectURL(url);
  state.coverUrls.clear();
  state.covers.clear();
});
window.addEventListener("online", () => { if (!state.accountReady) return; if (state.draft) retrySave().catch(() => {}); else if (!state.detail) refreshLibrary(); });
window.addEventListener("offline", () => {
  if (!state.accountReady) return;
  state.bridgeOnline = false;
  if (state.detail) status("Reading offline", "Your position stays on this device until you reconnect.");
  else { el("library-status").textContent = "Offline. Open a book saved on this device."; renderLibrary(); }
});
(async () => {
  const account = await window.ReaderAccount.ready;
  OfflineBooks.setScope(account.scope);
  storagePrefix = account.scope === "local" ? "books-pending:" : `books-pending:${account.scope}:`;
  state.accountReady = true;
  // Refresh the offline shell during connected visits, even without a new download.
  OfflineBooks.prepareShell().catch(() => {});
  try { await loadSavedBooks(); }
  catch { el("offline-status").textContent = "Device storage is unavailable in this browser"; }
  await refreshLibrary();
})().catch((error) => showError("library-error", error.message));
