import contextlib
import copy
import io
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from companion import (CompanionError, MAX_BODY, SyncClient, encode, metadata_book,
                       read_config, server_origin, snapshot_batches, sync, write_config)


def fixture_book(identifier="book-one"):
    return {"id": identifier, "title": "A book", "author": "Author", "progress": .25,
            "lastReadAt": "2026-11-14T00:00:00Z", "readable": True,
            "applePosition": {"cfi": "epubcfi(/6/2!/4/2:0)", "updatedAt": None, "revision": "apple-revision"},
            "annotations": [{"id": "mark-one", "type": "highlight", "cfi": "epubcfi(/6/2!/4/2,:0,:4)",
                             "text": "Text", "note": "A note", "color": "yellow"}]}


class CompanionTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / ".local/companion.json"
        self.config = {"server": "https://reader.example", "deviceId": "device-one", "name": "Test Mac",
                       "credential": "device_" + "a" * 43, "sequence": 1000, "allowLocalHttp": False}

    def test_only_metadata_is_serialized(self):
        detail = fixture_book()
        detail.update({"sourcePath": "/private/book.epub", "epub": b"private bytes", "cover": b"image bytes",
                       "epubUrl": "/api/secret/epub", "coverUrl": "/api/secret/cover", "credential": "secret",
                       "webPosition": {"private": True}, "ZPATH": "/another/private/path"})
        detail["applePosition"]["sourcePath"] = "/private/apple"
        detail["annotations"][0]["epub"] = b"also private"
        metadata = metadata_book(detail)
        self.assertEqual(set(metadata), {"id", "title", "author", "progress", "lastReadAt",
                                         "availableOnMac", "applePosition", "annotations"})
        wire = encode(metadata).decode()
        self.assertNotIn("private", wire)
        self.assertNotIn("secret", wire)
        self.assertNotIn("epubUrl", wire)
        self.assertEqual(metadata["annotations"][0]["text"], "Text")
        self.assertEqual(metadata["applePosition"]["revision"], "apple-revision")

    def test_server_origin_requires_https_or_explicit_loopback_development(self):
        self.assertEqual(server_origin("https://reader.example/"), "https://reader.example")
        self.assertEqual(server_origin("http://127.0.0.1:8766", True), "http://127.0.0.1:8766")
        for value in (None, "http://reader.example", "http://127.0.0.1:8766", "https://user:password@reader.example",
                      "https://reader.example/path", "https://reader.example/?token=secret", "https://reader.example/#x",
                      "https://reader.example:bad", "https://reader.example:0", "https://reader.example\\@other.example"):
            with self.subTest(value=value), self.assertRaises(CompanionError):
                server_origin(value)
        for value in ("http://localhost:8766", "http://127.0.0.1.evil.example", "http://[::1]"):
            with self.subTest(value=value), self.assertRaises(CompanionError):
                server_origin(value, True)

    def test_redirect_never_forwards_device_credential(self):
        seen = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append((self.path, self.headers.get("Authorization")))
                self.send_response(302)
                self.send_header("Location", "/api/credential-target")
                self.end_headers()

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        client = SyncClient(f"http://127.0.0.1:{server.server_port}", self.config["credential"], True)
        with self.assertRaisesRegex(CompanionError, "redirected"):
            client.request("GET", "/api/redirect")
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0][0], "/api/redirect")
        self.assertEqual(seen[0][1], "Bearer " + self.config["credential"])

    def test_config_is_private_and_rejects_broad_permissions(self):
        write_config(self.config, self.path)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.path.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(read_config(self.path), self.config)
        self.path.chmod(0o644)
        with self.assertRaisesRegex(CompanionError, "0600"):
            read_config(self.path)

    def test_batches_respect_byte_and_book_limits_without_losing_books(self):
        book = metadata_book(fixture_book())
        books = [dict(book, id=str(index)) for index in range(405)]
        batches = snapshot_batches(books)
        self.assertEqual([len(batch) for batch in batches], [200, 200, 5])
        self.assertEqual([item["id"] for batch in batches for item in batch], [str(index) for index in range(405)])
        large = copy.deepcopy(book)
        large["annotations"][0]["text"] = "é" * 220_000
        batches = snapshot_batches([large, large, large])
        self.assertEqual([len(batch) for batch in batches], [2, 1])
        self.assertTrue(all(len(encode({"sequence": 9007199254740991, "books": batch})) <= MAX_BODY for batch in batches))
        large["annotations"][0]["text"] = "é" * 600_000
        with self.assertRaisesRegex(CompanionError, "nothing was sent"):
            snapshot_batches([book, large])

    def test_sync_is_metadata_only_and_reserves_sequence_before_send(self):
        write_config(self.config, self.path)
        calls = []
        path = self.path

        class Library:
            def list_books(self):
                return {"books": [{"id": str(index)} for index in range(201)]}

            def book(self, identifier):
                return fixture_book(identifier)

            def epub(self, identifier):
                raise AssertionError("Book bytes must never be requested")

            def cover(self, identifier):
                raise AssertionError("Cover bytes must never be requested")

        class Client:
            def request(self, method, endpoint, payload=None):
                calls.append((method, endpoint, payload))
                if method == "POST":
                    self_sequence = json.loads(path.read_text())["sequence"]
                    if self_sequence != payload["sequence"]:
                        raise AssertionError("Sequence was not durable before sending")
                    return {"ok": True, "sequence": payload["sequence"]}
                return {"positions": [{"bookId": "private-book", "position": {"cfi": "private-position"}}]}

        output = io.StringIO()
        with contextlib.redirect_stdout(output), patch("companion.time.time_ns", return_value=500_000_000):
            sync(self.path, Library(), Client())
        posts = [call for call in calls if call[0] == "POST"]
        self.assertEqual([call[2]["sequence"] for call in posts], [1001, 1002])
        self.assertEqual([len(call[2]["books"]) for call in posts], [200, 1])
        self.assertTrue(all(call[1] == "/api/companion/snapshot" for call in posts))
        self.assertEqual(calls[-1][1], "/api/companion/positions")
        self.assertIn("1 web positions", output.getvalue())
        self.assertNotIn("private", output.getvalue())
        self.assertNotIn(self.config["credential"], output.getvalue())


if __name__ == "__main__":
    unittest.main()
