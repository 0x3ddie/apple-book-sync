"use strict";

const CACHE = "books-reader-shell-v14";
const SHELL = ["/", "/styles.css", "/account.js", "/reader.js", "/transfer.js", "/covers.js", "/offline.js", "/vendor/epub.js", "/vendor/jszip.min.js"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.map((url) => new Request(url, { cache: "reload" })));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("books-reader-shell-") && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // API responses, book files, and credentials are never cached here.
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !SHELL.includes(url.pathname) || url.search) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok) return response;
      const saved = await caches.match(event.request);
      return saved || response;
    } catch (error) {
      const saved = await caches.match(event.request);
      if (saved) return saved;
      throw error;
    }
  })());
});
