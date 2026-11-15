"use strict";

// Only connection descriptions use the API. EPUB bytes arrive over the direct,
// encrypted data channel and are committed to this browser before acknowledging.
window.BookTransfer = (() => {
  const MAX_BYTES = 128 * 1024 * 1024;
  const MAX_COVER_BYTES = 16 * 1024 * 1024;
  const connectionHelp = "Keep your Mac awake with transfers running, and connect both devices to the same Wi-Fi. Then try again.";
  const errors = {
    BOOK_UNAVAILABLE: "Download this EPUB in Apple Books on your Mac, then sync and try again.",
    BOOK_TOO_LARGE: "This book exceeds the 128 MB transfer limit.",
    TRANSFER_FAILED: `The Mac could not send this book. ${connectionHelp}`,
  };

  async function receive({ bookId, kind = "epub", bookIds, request, signal, onProgress = () => {}, save }) {
    if (!["epub", "covers"].includes(kind)) throw new Error("Unsupported transfer type.");
    const covers = kind === "covers";
    if (covers && (!Array.isArray(bookIds) || !bookIds.length || bookIds.length > 200 || bookIds[0] !== bookId
      || new Set(bookIds).size !== bookIds.length || bookIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(id)))) {
      throw new Error("Invalid books for cover transfer.");
    }
    const maxBytes = covers ? MAX_COVER_BYTES : MAX_BYTES;
    if (typeof RTCPeerConnection !== "function") throw new Error("Direct book transfer is unavailable in this browser. Try the latest Chrome.");
    if (signal?.aborted) throw new DOMException("Download cancelled.", "AbortError");
    const peer = new RTCPeerConnection({ iceServers: [] });
    const channel = peer.createDataChannel(covers ? "books-covers-v1" : "books-epub-v1", { ordered: true });
    channel.binaryType = "arraybuffer";
    let id, header, received = 0, chunks = [], ended = false, settled = false, answered = false;
    let resolveResult, rejectResult, messageQueue = Promise.resolve(), negotiation;
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    // Negotiation can still be gathering ICE when cancellation rejects result.
    // Attach a handler immediately; the public await below retains its rejection.
    result.catch(() => {});
    const stop = new AbortController();
    const fail = (error) => {
      if (settled) return;
      settled = true;
      stop.abort();
      rejectResult(error);
      peer.close();
    };
    const abort = () => fail(new DOMException("Download cancelled.", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => fail(new Error(`The transfer timed out. ${connectionHelp}`)), 150000);
    const connectionTimeout = setTimeout(() => {
      if (!header) fail(new Error(`Could not connect to your Mac. ${connectionHelp}`));
    }, 50000);

    async function delay(milliseconds) {
      if (stop.signal.aborted) throw new DOMException("Transfer stopped.", "AbortError");
      await new Promise((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(new DOMException("Transfer stopped.", "AbortError")); };
        const timer = setTimeout(() => { stop.signal.removeEventListener("abort", cancel); resolve(); }, milliseconds);
        stop.signal.addEventListener("abort", cancel, { once: true });
      });
    }
    async function gather() {
      stop.signal.throwIfAborted();
      if (peer.iceGatheringState === "complete") return;
      await new Promise((resolve, reject) => {
        const finish = (error) => {
          clearTimeout(timer);
          peer.removeEventListener("icegatheringstatechange", check);
          stop.signal.removeEventListener("abort", cancel);
          error ? reject(error) : resolve();
        };
        const check = () => { if (peer.iceGatheringState === "complete") finish(); };
        const cancel = () => finish(new DOMException("Transfer stopped.", "AbortError"));
        const timer = setTimeout(() => finish(new Error(`Could not prepare a direct connection. ${connectionHelp}`)), 10000);
        peer.addEventListener("icegatheringstatechange", check);
        stop.signal.addEventListener("abort", cancel, { once: true });
        check();
      });
    }
    async function message(data) {
      if (settled) return;
      if (typeof data !== "string") {
        if (!header || ended || !(data instanceof ArrayBuffer) || !data.byteLength || data.byteLength > 65536 || received + data.byteLength > header.size) {
          throw new Error("The Mac sent an invalid book transfer. Please try again.");
        }
        chunks.push(data);
        received += data.byteLength;
        onProgress({ phase: "receiving", received, total: header.size });
        return;
      }
      if (data.length > 4096) throw new Error("The transfer message is invalid.");
      let value;
      try { value = JSON.parse(data); } catch { throw new Error("The transfer message is invalid."); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The transfer message is invalid.");
      if (value.type === (covers ? "covers" : "book") && !header && !ended) {
        if (value.bookId !== bookId || !Number.isSafeInteger(value.size) || value.size < 4 || value.size > maxBytes || !/^[a-f0-9]{64}$/.test(value.sha256)) {
          throw new Error("The Mac sent a different or unsupported book. Please try again.");
        }
        header = value;
        clearTimeout(connectionTimeout);
        onProgress({ phase: "receiving", received: 0, total: value.size });
      } else if (value.type === "end" && header && !ended) {
        ended = true;
        if (received !== header.size) throw new Error("The book transfer was incomplete. Please try saving it again.");
        onProgress({ phase: "verifying", received, total: header.size });
        const bytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; }
        chunks = [];
        if (!covers && (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04)) throw new Error("The transferred file is not an EPUB archive.");
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
        if (digest !== header.sha256) throw new Error("The book failed its integrity check. Please save it again.");
        if (settled) return;
        onProgress({ phase: "saving", received, total: header.size });
        const stored = await save(new Blob([bytes], { type: covers ? "application/json" : "application/epub+zip" }));
        if (settled) return;
        // A receipt means the complete, checked book is durable on this device.
        if (channel.readyState === "open") channel.send(JSON.stringify({ type: "received" }));
        settled = true;
        stop.abort();
        resolveResult(stored);
      } else if (value.type === "error" && !ended) {
        throw new Error(errors[value.code] || "The Mac could not send this book. Please try again.");
      } else throw new Error("The book transfer arrived out of order. Please try again.");
    }
    channel.addEventListener("message", (event) => { messageQueue = messageQueue.then(() => message(event.data)).catch(fail); });
    channel.addEventListener("error", () => fail(new Error(`The direct connection failed. ${connectionHelp}`)));
    channel.addEventListener("close", () => { if (!ended && !settled) fail(new Error(`The transfer was interrupted. ${connectionHelp}`)); });
    peer.addEventListener("connectionstatechange", () => {
      if (!ended && ["failed", "closed"].includes(peer.connectionState)) fail(new Error(`Could not connect to your Mac. ${connectionHelp}`));
    });
    async function cleanupSignal() {
      if (!id) return;
      const closing = id;
      id = null;
      try { await request(`/api/transfers/${encodeURIComponent(closing)}/close`, { method: "POST", body: {} }); }
      catch { /* Short-lived connection metadata also expires on the server. */ }
    }
    negotiation = (async () => {
      onProgress({ phase: "connecting" });
      await peer.setLocalDescription(await peer.createOffer());
      if (settled) return;
      await gather();
      if (settled) return;
      const created = await request("/api/transfers", { method: "POST", body: { bookId, ...(covers ? { kind: "covers", bookIds } : {}), offer: { type: "offer", sdp: peer.localDescription.sdp } } });
      if (typeof created.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(created.id)) throw new Error("The server could not start this transfer.");
      id = created.id;
      if (settled) { await cleanupSignal(); return; }
      while (!settled && !answered) {
        const session = await request(`/api/transfers/${encodeURIComponent(id)}`);
        if (settled) return;
        if (session.bookId !== bookId || (covers ? session.kind !== "covers" : session.kind && session.kind !== "epub")) throw new Error("The transfer does not match the selected book.");
        if (session.status === "failed") throw new Error(errors[session.error] || "The Mac could not send this book. Please try again.");
        if (session.status === "answered") {
          if (session.answer?.type !== "answer" || typeof session.answer.sdp !== "string") throw new Error("The Mac returned an invalid connection response.");
          await peer.setRemoteDescription(session.answer);
          answered = true;
        } else await delay(1000);
      }
    })().catch((error) => { if (!settled) fail(error); });
    try { return await result; }
    finally {
      clearTimeout(timeout);
      clearTimeout(connectionTimeout);
      signal?.removeEventListener("abort", abort);
      stop.abort();
      // Give the small receipt a chance to drain before closing the data channel.
      if (ended && channel.readyState === "open" && channel.bufferedAmount) {
        await new Promise((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            channel.removeEventListener("bufferedamountlow", finish);
            channel.removeEventListener("close", finish);
            resolve();
          };
          const timer = setTimeout(finish, 1000);
          channel.bufferedAmountLowThreshold = 0;
          channel.addEventListener("bufferedamountlow", finish, { once: true });
          channel.addEventListener("close", finish, { once: true });
          if (!channel.bufferedAmount) finish();
        });
      }
      peer.close();
      chunks = [];
      await cleanupSignal();
      // A create request already in flight still cleans up its returned ID.
      negotiation.catch(() => {});
    }
  }
  return { receive };
})();
