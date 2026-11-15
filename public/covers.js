"use strict";

// Cover images remain in device storage. Parsing a saved EPUB never fetches
// an external URL, and cover bundles arrive only over the direct data channel.
window.BookCovers = (() => {
  const MAX_BUNDLE = 16 * 1024 * 1024;
  const MAX_THUMBNAIL = 256 * 1024;
  const MAX_EPUB = 128 * 1024 * 1024;
  const MAX_XML = 1024 * 1024;
  const MAX_IMAGE = 4 * 1024 * 1024;
  const idPattern = /^[A-Za-z0-9._:-]{1,200}$/;
  const fail = () => new Error("Invalid cover bundle. Please refresh your library and try again.");
  const exact = (object, keys) => object && typeof object === "object" && !Array.isArray(object)
    && Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));
  const jpeg = (bytes) => bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;

  async function readBundle(blob, bookIds) {
    if (!(blob instanceof Blob) || blob.size < 1 || blob.size > MAX_BUNDLE || !Array.isArray(bookIds)
      || !bookIds.length || bookIds.length > 200 || new Set(bookIds).size !== bookIds.length
      || bookIds.some((id) => typeof id !== "string" || !idPattern.test(id))) throw fail();
    let bundle;
    try { bundle = JSON.parse(await blob.text()); } catch { throw fail(); }
    if (!exact(bundle, ["version", "covers"]) || bundle.version !== 1 || !Array.isArray(bundle.covers) || bundle.covers.length !== bookIds.length) throw fail();
    const expected = new Set(bookIds), seen = new Set(), records = [], checkedAt = new Date().toISOString();
    for (const item of bundle.covers) {
      if (!exact(item, ["id", "mime", "data"]) || !expected.has(item.id) || seen.has(item.id)) throw fail();
      seen.add(item.id);
      let cover = null;
      if (item.mime !== null || item.data !== null) {
        if (item.mime !== "image/jpeg" || typeof item.data !== "string" || !item.data.length
          || item.data.length > 4 * Math.ceil(MAX_THUMBNAIL / 3)
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data)) throw fail();
        let decoded;
        try { decoded = atob(item.data); } catch { throw fail(); }
        if (decoded.length > MAX_THUMBNAIL) throw fail();
        const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
        if (!jpeg(bytes)) throw fail();
        cover = new Blob([bytes], { type: "image/jpeg" });
      }
      records.push({ id: item.id, cover, checkedAt });
    }
    return records;
  }

  function memberPath(base, reference) {
    if (typeof reference !== "string" || !reference || reference.length > 2048) return null;
    let decoded;
    try { decoded = decodeURIComponent(reference); } catch { return null; }
    if (/^[a-z][a-z\d+.-]*:/i.test(decoded) || /^[\\/]/.test(decoded) || /[\\\x00-\x1f?#]/.test(decoded)) return null;
    const parts = base ? base.split("/").slice(0, -1) : [];
    for (const part of decoded.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") { if (!parts.length) return null; parts.pop(); }
      else parts.push(part);
    }
    return parts.length ? parts.join("/") : null;
  }
  function readEntry(zip, name, limit) {
    const entry = zip.file(name);
    if (!entry || entry.dir || entry.unsafeOriginalName?.split("/").includes("..")) return Promise.reject(new Error("Missing EPUB cover data."));
    // Stream inflation prevents a tiny compressed member from allocating an
    // unbounded image or XML document before its size can be checked.
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0, ended = false;
      const stream = entry.internalStream("uint8array");
      stream.on("data", (chunk) => {
        if (ended) return;
        size += chunk.length;
        if (size > limit) { ended = true; stream.pause(); reject(new Error("EPUB cover data is too large.")); return; }
        chunks.push(chunk);
      });
      stream.on("error", (error) => { if (!ended) { ended = true; reject(error); } });
      stream.on("end", () => {
        if (ended) return;
        ended = true;
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        resolve(bytes);
      });
      stream.resume();
    });
  }
  function xml(bytes) {
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("External XML declarations are not cover data.");
    const document = new DOMParser().parseFromString(text, "application/xml");
    if (document.getElementsByTagName("parsererror").length) throw new Error("Invalid EPUB cover metadata.");
    return document;
  }
  const nodes = (document, name) => Array.from(document.getElementsByTagName("*")).filter((node) => (node.localName || node.nodeName.split(":").at(-1)) === name);
  function rasterType(bytes) {
    if (jpeg(bytes)) return "image/jpeg";
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "image/png";
    if (bytes.length >= 6 && new TextDecoder().decode(bytes.subarray(0, 6)).match(/^GIF8[79]a$/)) return "image/gif";
    if (bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP") return "image/webp";
    return null;
  }
  async function fromEpub(blob) {
    if (!(blob instanceof Blob) || !blob.size || blob.size > MAX_EPUB) return null;
    try {
      const zip = await JSZip.loadAsync(await blob.arrayBuffer());
      const container = xml(await readEntry(zip, "META-INF/container.xml", MAX_XML));
      const root = nodes(container, "rootfile")[0]?.getAttribute("full-path");
      const packagePath = memberPath("", root);
      if (!packagePath) return null;
      const metadata = xml(await readEntry(zip, packagePath, MAX_XML));
      const items = nodes(metadata, "item");
      let item = items.find((node) => (node.getAttribute("properties") || "").split(/\s+/).includes("cover-image"));
      if (!item) {
        const coverId = nodes(metadata, "meta").find((node) => node.getAttribute("name") === "cover")?.getAttribute("content");
        if (coverId) item = items.find((node) => node.getAttribute("id") === coverId);
      }
      const coverPath = item && memberPath(packagePath, item.getAttribute("href"));
      if (!coverPath) return null;
      const bytes = await readEntry(zip, coverPath, MAX_IMAGE);
      const mime = rasterType(bytes);
      return mime ? new Blob([bytes], { type: mime }) : null;
    } catch { return null; } // Missing or malformed artwork never blocks reading.
  }
  return { fromEpub, readBundle };
})();
