import sqlite3
import http.client
import json
import tempfile
import threading
import unittest
import zipfile
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from library import BooksLibrary, BookNotDownloadedError, ConflictError, SF_DATALESS
from serve import Handler, ORIGIN


class LibraryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.apple = root / "apple"
        (self.apple / "BKLibrary").mkdir(parents=True)
        (self.apple / "AEAnnotation").mkdir()
        self.library_db = self.apple / "BKLibrary/library.sqlite"
        self.annotation_db = self.apple / "AEAnnotation/annotations.sqlite"
        self.epub = root / "fixture.epub"
        with zipfile.ZipFile(self.epub, "w") as archive:
            archive.writestr("mimetype", "application/epub+zip")
            archive.writestr("META-INF/container.xml", '<container><rootfiles><rootfile full-path="OEBPS/package.opf"/></rootfiles></container>')
            archive.writestr("OEBPS/package.opf", '<package><metadata><meta name="cover" content="cover"/></metadata><manifest><item id="cover" href="cover.jpg" media-type="image/jpeg"/></manifest></package>')
            archive.writestr("OEBPS/cover.jpg", b"test cover")
        with sqlite3.connect(self.library_db) as db:
            db.execute("CREATE TABLE ZBKLIBRARYASSET (ZASSETID TEXT, ZTITLE TEXT, ZAUTHOR TEXT, ZPATH TEXT, ZREADINGPROGRESS REAL, ZLASTOPENDATE REAL, ZISHIDDEN INTEGER)")
            db.executemany("INSERT INTO ZBKLIBRARYASSET VALUES (?,?,?,?,?,?,?)", [
                ("one", "First book", "Author", str(self.epub), .2, 1000, 0),
                ("two", "Second book", "Author", str(self.epub), 0, 900, 0),
                ("missing", "Cloud book", "Author", str(root / "missing.epub"), 0, 0, 0),
            ])
        with sqlite3.connect(self.annotation_db) as db:
            db.execute("""CREATE TABLE ZAEANNOTATION (
                Z_PK INTEGER PRIMARY KEY, ZANNOTATIONASSETID TEXT, ZANNOTATIONTYPE INTEGER,
                ZANNOTATIONDELETED INTEGER, ZANNOTATIONLOCATION TEXT,
                ZANNOTATIONMODIFICATIONDATE REAL, ZANNOTATIONUUID TEXT,
                ZANNOTATIONSELECTEDTEXT TEXT, ZANNOTATIONNOTE TEXT, ZANNOTATIONSTYLE INTEGER)""")
            db.executemany("INSERT INTO ZAEANNOTATION VALUES (?,?,?,?,?,?,?,?,?,?)", [
                (1, "one", 3, 0, "epubcfi(/6/2!/4/2:0)", 1000, "position", None, None, None),
                (2, "one", 2, 0, "epubcfi(/6/2!/4/2,:0,:4)", 900, "highlight", "Text", "A note", 3),
                (3, "one", 2, 1, "epubcfi(/6/2!/4/4,:0,:4)", 1100, "deleted", "Deleted", None, 4),
                (4, "one", 1, 0, "epubcfi(/6/2!/4/8:0)", 800, "bookmark", None, None, None),
            ])
        self.api = BooksLibrary(self.apple, root / "web")

    def payload(self, book_id="one", cfi="epubcfi(/6/2!/4/4:0)", client="session_one", sequence=1, revision=0):
        return {"cfi": cfi, "clientId": client, "sequence": sequence, "baseRevision": revision,
                "appleRevision": (self.api.book(book_id)["applePosition"] or {}).get("revision")}

    def change_apple_position(self):
        with sqlite3.connect(self.annotation_db) as db:
            db.execute("UPDATE ZAEANNOTATION SET ZANNOTATIONLOCATION=?, ZANNOTATIONMODIFICATIONDATE=? WHERE Z_PK=1",
                       ("epubcfi(/6/2!/4/20:0)", 2000))

    def test_library_and_live_annotations(self):
        books = self.api.list_books()["books"]
        self.assertEqual(len(books), 3)
        self.assertEqual(sum(book["readable"] for book in books), 2)
        book = self.api.book("one")
        self.assertEqual(book["syncState"], "apple")
        self.assertEqual(book["resume"]["source"], "apple")
        self.assertEqual({a["id"] for a in book["annotations"]}, {"highlight", "bookmark"})
        self.assertEqual(book["annotations"][0]["color"], "yellow")
        self.assertEqual(book["annotations"][0]["note"], "A note")
        self.assertEqual(self.api.cover("one"), (b"test cover", "image/jpeg"))

    def test_positions_are_durable_and_isolated_by_book(self):
        apple_before = self.annotation_db.read_bytes()
        first = self.api.save_position("one", self.payload())
        second = self.api.save_position("two", self.payload("two", cfi="epubcfi(/6/8!/4/2:0)"))
        reopened = BooksLibrary(self.apple, self.api.data_root)
        self.assertEqual(reopened.book("one")["resume"], {"cfi": first["position"]["cfi"], "source": "web"})
        self.assertEqual(reopened.book("two")["resume"]["cfi"], second["position"]["cfi"])
        self.assertEqual(self.annotation_db.read_bytes(), apple_before)
        self.assertEqual(reopened.book("one")["syncState"], "pending")

    def test_out_of_order_and_duplicate_saves_do_not_rewind(self):
        self.api.save_position("one", self.payload(sequence=1))
        current = self.api.save_position("one", self.payload(cfi="epubcfi(/6/2!/4/12:0)", sequence=3))
        stale = self.api.save_position("one", self.payload(sequence=2))
        duplicate = self.api.save_position("one", self.payload(sequence=3))
        self.assertTrue(stale["ignored"])
        self.assertEqual(stale["position"], current["position"])
        self.assertEqual(duplicate["position"], current["position"])

    def test_a_different_reader_must_use_current_web_revision(self):
        current = self.api.save_position("one", self.payload())
        with self.assertRaises(ConflictError):
            self.api.save_position("one", self.payload(client="other_session"))
        accepted = self.api.save_position("one", self.payload(client="other_session", revision=current["position"]["revision"]))
        self.assertEqual(accepted["position"]["revision"], 2)
        # A late request from the first session cannot replace the new session.
        with self.assertRaises(ConflictError):
            self.api.save_position("one", self.payload(sequence=9))

    def test_offline_reader_can_save_after_mac_download_is_removed(self):
        payload = self.payload()
        self.epub.unlink()
        self.assertFalse(self.api.book("one")["readable"])
        saved = self.api.save_position("one", payload)
        self.assertEqual(saved["position"]["cfi"], payload["cfi"])
        self.assertEqual(self.api.book("one")["resume"]["source"], "web")

    def test_changed_apple_baseline_prompts_instead_of_overwriting(self):
        payload = self.payload()
        self.api.save_position("one", payload)
        self.change_apple_position()
        current = self.api.book("one")
        self.assertEqual(current["syncState"], "conflict")
        self.assertEqual(current["resume"]["cfi"], payload["cfi"])
        payload["sequence"] = 2
        with self.assertRaises(ConflictError):
            self.api.save_position("one", payload)
        payload["appleRevision"] = current["applePosition"]["revision"]
        resolved = self.api.save_position("one", payload)
        self.assertEqual(resolved["syncState"], "pending")
        self.assertEqual(self.api.book("one")["syncState"], "pending")

    def test_invalid_input_and_unknown_book_do_not_write(self):
        for patch_value in ({"cfi": "../../etc/passwd"}, {"sequence": True}, {"percentage": float("nan")}, {"clientId": "../bad"}):
            with self.assertRaises(ValueError):
                self.api.save_position("one", self.payload() | patch_value)
        with self.assertRaises(KeyError):
            self.api.book("../outside")
        with self.assertRaises(ValueError):
            self.api.entry(self.epub, "../secret")
        self.assertIsNone(self.api.web_position("one"))

    def test_dataless_cloud_members_are_not_read_or_downloaded(self):
        with patch.object(Path, "stat", return_value=SimpleNamespace(st_flags=SF_DATALESS)), \
             patch.object(Path, "read_bytes") as read:
            with self.assertRaises(BookNotDownloadedError):
                self.api.entry(self.epub, "META-INF/container.xml")
            read.assert_not_called()

    def test_http_origin_and_revision_boundaries(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.library = self.api
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def request(method, path, payload=None, origin=ORIGIN, host="127.0.0.1:8765"):
            connection = http.client.HTTPConnection(*server.server_address, timeout=3)
            try:
                body = json.dumps(payload) if payload is not None else None
                connection.request(method, path, body, {"Host": host, "Origin": origin, "Content-Type": "application/json"})
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()

        try:
            self.assertEqual(request("GET", "/api/library")[0], 200)
            self.assertEqual(request("GET", "/api/library", host="attacker.test")[0], 403)
            payload = self.payload()
            self.assertEqual(request("POST", "/api/books/one/position", payload, origin="https://attacker.test")[0], 403)
            self.assertEqual(request("POST", "/api/books/one/position", payload)[0], 200)
            self.assertEqual(request("GET", "/api/books/%2E%2E%2Foutside/epub")[0], 404)
            self.change_apple_position()
            payload["sequence"] = 2
            status, body = request("POST", "/api/books/one/position", payload)
            self.assertEqual(status, 409)
            self.assertEqual(body["book"]["syncState"], "conflict")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
