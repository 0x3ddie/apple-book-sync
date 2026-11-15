"""Serve the local library and progress bridge without writing Apple Books data."""

import json
import mimetypes
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

from library import BooksLibrary, ConflictError


ROOT = Path(__file__).resolve().parent
PORT = 8765
ORIGIN = f"http://127.0.0.1:{PORT}"
FILES = {
    "/": ROOT / "public/index.html",
    "/reader.js": ROOT / "public/reader.js",
    "/offline.js": ROOT / "public/offline.js",
    "/transfer.js": ROOT / "public/transfer.js",
    "/covers.js": ROOT / "public/covers.js",
    "/account.js": ROOT / "public/account.js",
    "/sw.js": ROOT / "public/sw.js",
    "/styles.css": ROOT / "public/styles.css",
    "/vendor/epub.js": ROOT / "node_modules/epubjs/dist/epub.js",
    "/vendor/jszip.min.js": ROOT / "node_modules/jszip/dist/jszip.min.js",
}


class Handler(BaseHTTPRequestHandler):
    def send_bytes(self, status, payload, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def json(self, status, payload):
        self.send_bytes(status, json.dumps(payload, allow_nan=False).encode(), "application/json; charset=utf-8")

    def valid_host(self):
        return self.headers.get("Host") == f"127.0.0.1:{PORT}"

    @property
    def library(self):
        return self.server.library

    def route(self):
        pieces = urlsplit(self.path).path.split("/")
        if len(pieces) not in (4, 5) or pieces[1:3] != ["api", "books"]:
            raise KeyError("Route not found")
        book_id = unquote(pieces[3])
        if not book_id or "/" in book_id or "\\" in book_id:
            raise KeyError("Book not found")
        return book_id, pieces[4] if len(pieces) == 5 else ""

    def do_GET(self):
        if not self.valid_host():
            self.json(403, {"error": "This library is available only on this Mac."})
            return
        path = urlsplit(self.path).path
        try:
            if path in FILES:
                file = FILES[path]
                if not file.is_file():
                    raise KeyError("File not found")
                self.send_bytes(200, file.read_bytes(), mimetypes.guess_type(file.name)[0] or "application/octet-stream")
            elif path == "/api/session":
                self.json(200, {"mode": "local", "user": None})
            elif path == "/api/library":
                self.json(200, self.library.list_books())
            else:
                book_id, action = self.route()
                if action == "":
                    self.json(200, self.library.book(book_id))
                elif action == "epub":
                    self.send_bytes(200, self.library.epub(book_id).read_bytes(), "application/epub+zip")
                elif action == "cover":
                    payload, mime = self.library.cover(book_id)
                    self.send_bytes(200, payload, mime)
                else:
                    raise KeyError("Route not found")
        except KeyError as error:
            self.json(404, {"error": str(error.args[0])})
        except (ValueError, RuntimeError, OSError, sqlite3.Error, ElementTree.ParseError) as error:
            self.json(503, {"error": str(error)})

    def do_POST(self):
        if not self.valid_host() or self.headers.get("Origin") != ORIGIN:
            self.json(403, {"error": "This request must come from the local reader."})
            return
        try:
            book_id, action = self.route()
            if action != "position":
                raise KeyError("Route not found")
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16384:
                raise ValueError("Invalid position payload size")
            payload = json.loads(self.rfile.read(length))
            self.json(200, self.library.save_position(book_id, payload))
        except KeyError as error:
            self.json(404, {"error": str(error.args[0])})
        except ConflictError as error:
            self.json(409, {"error": str(error), "book": error.book})
        except (ValueError, UnicodeError) as error:
            self.json(400, {"error": str(error)})
        except (RuntimeError, OSError, sqlite3.Error) as error:
            self.json(503, {"error": str(error)})

    def log_message(self, format, *args):
        print(f"{self.command} response", flush=True)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.library = BooksLibrary()
    print(f"Local Books library: {ORIGIN}", flush=True)
    server.serve_forever()
