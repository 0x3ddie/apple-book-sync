import handle from "../cloud/handler.mjs";
import { isIP } from "node:net";

// Vercel's Fetch handler keeps session cookies and streaming limits intact.
export default {
  fetch(request) {
    const headers = new Headers(request.headers);
    // Vercel overwrites this platform header. Never trust a caller-provided
    // x-books-client-ip, including during local development.
    const address = process.env.VERCEL === "1" ? headers.get("x-vercel-forwarded-for")?.trim() : null;
    headers.set("x-books-client-ip", address && isIP(address) ? address : "127.0.0.1");
    return handle(new Request(request, { headers }));
  },
};
