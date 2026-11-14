import { mkdir, copyFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "vendor"), { recursive: true });
// Explicit allowlist: the Mac bridge, its private state, EPUBs, and screenshots
// can never be copied into the public deployment by this build.
for (const file of ["index.html", "styles.css", "reader.js", "transfer.js", "offline.js", "account.js", "sw.js"]) {
  await copyFile(resolve(root, "public", file), resolve(output, file));
}
await copyFile(resolve(root, "node_modules/epubjs/dist/epub.js"), resolve(output, "vendor/epub.js"));
await copyFile(resolve(root, "node_modules/jszip/dist/jszip.min.js"), resolve(output, "vendor/jszip.min.js"));
console.log("Built public reader shell. No library data or EPUB files included.");
