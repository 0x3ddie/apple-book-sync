import contextlib
import copy
import io
import json
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch

from companion import (CompanionError, MAX_BODY, SyncClient, encode, metadata_book, migrate_legacy_config, pair,
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

    def test_legacy_migration_preserves_private_pairing_and_is_idempotent(self):
        source = Path(self.temporary.name) / "checkout/.local/companion.json"
        write_config(self.config, source)
        migrate_legacy_config(source, self.path)
        self.assertEqual(read_config(self.path), self.config)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.path.parent.stat().st_mode & 0o777, 0o700)
        self.assertFalse(source.exists())
        migrated_bytes = self.path.read_bytes()
        migrate_legacy_config(source, self.path)
        migrate_legacy_config(self.path, self.path)
        self.assertEqual(self.path.read_bytes(), migrated_bytes)

    def test_legacy_migration_never_replaces_an_existing_identity(self):
        source = Path(self.temporary.name) / "checkout/.local/companion.json"
        existing = dict(self.config, deviceId="existing-device", credential="device_" + "b" * 43)
        write_config(self.config, source)
        write_config(existing, self.path)
        migrate_legacy_config(source, self.path)
        self.assertEqual(read_config(self.path), existing)
        self.assertEqual(read_config(source), self.config)

    def test_failed_migration_keeps_the_original_pairing(self):
        source = Path(self.temporary.name) / "checkout/.local/companion.json"
        write_config(self.config, source)
        with patch("companion.write_config", side_effect=OSError("Disk full")):
            with self.assertRaisesRegex(OSError, "Disk full"):
                migrate_legacy_config(source, self.path)
        self.assertEqual(read_config(source), self.config)
        self.assertFalse(self.path.exists())

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

    def test_background_sync_skips_all_cloud_requests_until_metadata_changes(self):
        write_config(self.config, self.path)
        detail = fixture_book()
        library = Mock()
        library.list_books.return_value = {"books": [{"id": detail["id"]}]}
        library.book.return_value = detail
        client = Mock()
        client.request.side_effect = lambda method, *args: {"positions": []} if method == "GET" else {"ok": True}
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(sync(self.path, library, client, skip_unchanged=True, quiet=True),
                             {"changed": True, "books": 1})
            self.assertEqual(client.request.call_count, 2)
            first_hash = read_config(self.path)["snapshotHash"]
            client.reset_mock()
            self.assertEqual(sync(self.path, library, client, skip_unchanged=True, quiet=True),
                             {"changed": False, "books": 1})
            client.request.assert_not_called()
            detail["annotations"][0]["note"] = "A changed note"
            self.assertEqual(sync(self.path, library, client, skip_unchanged=True, quiet=True),
                             {"changed": True, "books": 1})
            self.assertEqual(client.request.call_count, 2)
            self.assertNotEqual(read_config(self.path)["snapshotHash"], first_hash)
            self.assertEqual(output.getvalue(), "")

    def test_failed_snapshot_is_retried_instead_of_cached(self):
        write_config(self.config, self.path)
        library = Mock()
        library.list_books.return_value = {"books": [{"id": "book-one"}]}
        library.book.return_value = fixture_book()
        client = Mock()
        client.request.side_effect = [CompanionError("Connection interrupted"), {"ok": True}, {"positions": []}]
        with self.assertRaisesRegex(CompanionError, "Connection interrupted"):
            sync(self.path, library, client, skip_unchanged=True, quiet=True)
        failed_sequence = read_config(self.path)["sequence"]
        self.assertNotIn("snapshotHash", read_config(self.path))
        self.assertEqual(sync(self.path, library, client, skip_unchanged=True, quiet=True),
                         {"changed": True, "books": 1})
        requests = client.request.call_args_list
        self.assertEqual([call.args[:2] for call in requests],
                         [("POST", "/api/companion/snapshot"), ("POST", "/api/companion/snapshot"),
                          ("GET", "/api/companion/positions")])
        self.assertGreater(requests[1].args[2]["sequence"], failed_sequence)
        self.assertIn("snapshotHash", read_config(self.path))


class PairingTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / ".local/companion.json"
        self.wall_time = datetime(2026, 11, 14, tzinfo=timezone.utc).timestamp()
        self.elapsed = 0
        self.waits = []
        self.secret = "pair_" + "a" * 43
        self.credential = "device_" + "b" * 43
        self.expiry = datetime.fromtimestamp(self.wall_time + 300, timezone.utc).isoformat()
        self.start = {"code": "012345", "secret": self.secret, "expiresAt": self.expiry, "interval": 3}
        self.pending = {"status": "pending", "expiresAt": self.expiry}
        self.claimed = {"status": "claimed", "expiresAt": self.expiry,
                        "account": {"id": "account-one", "email": "reader@example.com"}}
        self.complete = {"device": {"id": "new-device"}, "credential": self.credential}
        self.request = self.enterContext(patch("companion.SyncClient.request"))
        self.confirm = self.enterContext(patch("builtins.input", return_value="yes"))
        self.enterContext(patch("companion.sys.stdin.isatty", return_value=True))
        self.enterContext(patch("companion.time.time", side_effect=lambda: self.wall_time + self.elapsed))
        self.enterContext(patch("companion.time.monotonic", side_effect=lambda: self.elapsed))

        def sleep(seconds):
            self.waits.append(seconds)
            self.elapsed += seconds
            if len(self.waits) > 105:
                raise AssertionError("Pairing did not expire")

        self.enterContext(patch("companion.time.sleep", side_effect=sleep))
        self.output = io.StringIO()
        self.enterContext(contextlib.redirect_stdout(self.output))

    def run_pair(self):
        return pair("https://reader.example", " Test Mac ", path=self.path)

    def test_phone_claim_requires_local_confirmation_before_credentials_are_saved(self):
        self.request.side_effect = [self.start, CompanionError("Rate limited", status=429),
                                    self.pending, self.claimed, self.complete]

        def confirm(prompt):
            self.assertFalse(self.path.exists())
            self.assertNotIn("/api/devices/pairing/complete", [call.args[1] for call in self.request.call_args_list])
            self.assertIn("reader@example.com", self.output.getvalue())
            return " YES "

        self.confirm.side_effect = confirm
        with patch("companion.BooksLibrary") as library, patch("companion.sync") as metadata_sync:
            self.assertTrue(self.run_pair())
        library.assert_not_called()
        metadata_sync.assert_not_called()
        self.assertEqual(self.waits, [3, 3, 3])
        self.assertEqual([call.args for call in self.request.call_args_list], [
            ("POST", "/api/devices/pairing/start", {"name": "Test Mac"}),
            *[("POST", "/api/devices/pairing/poll", {"secret": self.secret}) for _ in range(3)],
            ("POST", "/api/devices/pairing/complete", {"secret": self.secret, "accountId": "account-one", "approve": True}),
        ])
        config = read_config(self.path)
        self.assertEqual(config["deviceId"], "new-device")
        self.assertEqual(config["credential"], self.credential)
        self.assertEqual(config["name"], "Test Mac")
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertIn("012 345", self.output.getvalue())
        self.assertNotIn(self.secret, self.output.getvalue())
        self.assertNotIn(self.credential, self.output.getvalue())

    def test_default_or_explicit_rejection_consumes_code_without_saving_credentials(self):
        for answer in ("", "no", "y"):
            with self.subTest(answer=answer):
                self.request.side_effect = [self.start, self.claimed, {"ok": True}]
                self.confirm.return_value = answer
                self.assertFalse(self.run_pair())
                self.request.assert_called_with("POST", "/api/devices/pairing/complete",
                                                {"secret": self.secret, "accountId": "account-one", "approve": False})
                self.assertFalse(self.path.exists())

    def test_pending_pairing_expires_without_confirmation_or_completion(self):
        self.request.side_effect = lambda method, endpoint, payload: self.start if endpoint.endswith("/start") else self.pending
        with self.assertRaisesRegex(CompanionError, "expired"):
            self.run_pair()
        self.assertEqual(self.elapsed, 300)
        self.confirm.assert_not_called()
        self.assertTrue(all(call.args[1].endswith(("/start", "/poll")) for call in self.request.call_args_list))
        self.assertFalse(self.path.exists())

    def test_expiry_during_confirmation_never_completes_or_writes(self):
        self.request.side_effect = [self.start, self.claimed]

        def delayed_confirmation(prompt):
            self.elapsed = 301
            return "yes"

        self.confirm.side_effect = delayed_confirmation
        with self.assertRaisesRegex(CompanionError, "expired before confirmation"):
            self.run_pair()
        self.assertEqual(self.request.call_count, 2)
        self.assertFalse(self.path.exists())

    def test_untrusted_pairing_responses_fail_closed(self):
        bad_account = dict(self.claimed, account={"id": "account-one", "email": "reader@example.com\x1b[2J"})
        changed_expiry = dict(self.claimed, expiresAt=datetime.fromtimestamp(self.wall_time + 301, timezone.utc).isoformat())
        for responses in ([dict(self.start, secret="not-a-pairing-secret")],
                          [dict(self.start, code="12\n345")],
                          [dict(self.start, expiresAt="2099-01-01T00:00:00Z")],
                          [self.start, bad_account], [self.start, changed_expiry],
                          [self.start, self.claimed, dict(self.complete, credential="not-a-device-credential")]):
            with self.subTest(responses=responses):
                self.elapsed = 0
                self.request.side_effect = responses
                with self.assertRaises(CompanionError):
                    self.run_pair()
                self.assertFalse(self.path.exists())
                self.assertNotIn("\x1b", self.output.getvalue())

    def test_existing_pairing_is_kept_without_network_requests(self):
        original = {"server": "https://reader.example", "deviceId": "already-paired", "name": "Old Mac",
                    "credential": self.credential, "sequence": 1, "allowLocalHttp": False}
        write_config(original, self.path)
        before = self.path.read_bytes()
        with self.assertRaisesRegex(CompanionError, "already has a pairing"):
            self.run_pair()
        self.request.assert_not_called()
        self.confirm.assert_not_called()
        self.assertEqual(self.path.read_bytes(), before)

    def test_missing_terminal_and_expired_server_session_never_save_credentials(self):
        with patch("companion.sys.stdin.isatty", return_value=False):
            with self.assertRaisesRegex(CompanionError, "terminal"):
                self.run_pair()
        self.request.assert_not_called()
        self.request.side_effect = [self.start, CompanionError("Expired", status=401)]
        with self.assertRaisesRegex(CompanionError, "expired or was cancelled"):
            self.run_pair()
        self.confirm.assert_not_called()
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main()
