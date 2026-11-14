"""Read Apple Books; keep web progress separately from Apple's private stores."""

import hashlib
import json
import math
import mimetypes
import posixpath
import re
import sqlite3
import threading
import zipfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlparse, quote
from xml.etree import ElementTree

from prepare import BOOKS, DATA, copy_epub


APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)
FONT_ENCRYPTION = {"http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"}
SF_DATALESS = 0x40000000


def now():
    return datetime.now(timezone.utc).isoformat()


def apple_date(value):
    try:
        return (APPLE_EPOCH + timedelta(seconds=float(value))).isoformat() if value else None
    except (ValueError, TypeError, OverflowError):
        return None


def source_path(book):
    raw = book.get("ZPATH") or ""
    return Path(unquote(urlparse(raw).path) if raw.startswith("file:") else raw) if raw else None


class ConflictError(Exception):
    def __init__(self, message, book):
        super().__init__(message)
        self.book = book


class BookNotDownloadedError(ValueError):
    pass


class BooksLibrary:
    def __init__(self, books_root=BOOKS, data_root=DATA):
        self.books_root = Path(books_root)
        self.data_root = Path(data_root)
        self.lock = threading.RLock()
        self.data_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        with self.state_connection() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS positions (
                book_id TEXT PRIMARY KEY, cfi TEXT NOT NULL, saved_at TEXT NOT NULL,
                revision INTEGER NOT NULL, client_id TEXT NOT NULL, sequence INTEGER NOT NULL,
                apple_revision TEXT, href TEXT, percentage REAL
            )""")

    @contextmanager
    def state_connection(self):
        db = sqlite3.connect(self.data_root / "reader.sqlite3", timeout=10)
        db.row_factory = sqlite3.Row
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def read_store(self, folder, query, parameters=()):
        paths = list((self.books_root / folder).glob("*.sqlite"))
        if len(paths) != 1:
            raise RuntimeError(f"Cannot read Apple Books {folder} data. Open Books on this Mac and allow app-data access.")
        db = sqlite3.connect(paths[0].as_uri() + "?mode=ro", uri=True, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            return [dict(row) for row in db.execute(query, parameters)]
        finally:
            db.close()

    def raw_books(self):
        return [row for row in self.read_store("BKLibrary", "SELECT * FROM ZBKLIBRARYASSET")
                if row.get("ZASSETID") and row.get("ZTITLE") and not row.get("ZISHIDDEN")]

    def raw_book(self, book_id):
        rows = self.read_store("BKLibrary", "SELECT * FROM ZBKLIBRARYASSET WHERE ZASSETID = ?", (book_id,))
        if not rows or rows[0].get("ZISHIDDEN"):
            raise KeyError("Book not found in Apple Books")
        return rows[0]

    def raw_annotations(self, book_id=None):
        query = "SELECT * FROM ZAEANNOTATION WHERE ZANNOTATIONDELETED IS NOT 1"
        if book_id is not None:
            query += " AND ZANNOTATIONASSETID = ?"
        query += " ORDER BY ZANNOTATIONMODIFICATIONDATE DESC, Z_PK DESC"
        if not (self.books_root / "AEAnnotation").exists():
            return []
        return self.read_store("AEAnnotation", query, () if book_id is None else (book_id,))

    def entry(self, source, name, max_size=20 * 1024 * 1024):
        """Read an EPUB member without extracting paths from the EPUB."""
        name = unquote(name)
        if not name or PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts:
            raise ValueError("Invalid EPUB member path")
        if getattr(source.stat(), "st_flags", 0) & SF_DATALESS:
            raise BookNotDownloadedError("Download this book in Apple Books on your Mac first.")
        if source.is_dir():
            member = source / name
            # Inspect every parent before traversing it: entering an iCloud
            # dataless directory can block on a download even for a stat call.
            current = source
            for component in PurePosixPath(name).parts:
                current = current / component
                try:
                    info = current.lstat()
                except FileNotFoundError:
                    raise KeyError(name) from None
                if getattr(info, "st_flags", 0) & SF_DATALESS:
                    raise BookNotDownloadedError("Download this book in Apple Books on your Mac first.")
            if not member.resolve().is_relative_to(source.resolve()):
                raise ValueError("EPUB member escapes the book package")
            if not member.is_file():
                raise KeyError(name)
            if member.stat().st_size > max_size:
                raise ValueError("EPUB member is too large")
            return member.read_bytes()
        with zipfile.ZipFile(source) as archive:
            info = archive.getinfo(name)
            if info.file_size > max_size:
                raise ValueError("EPUB member is too large")
            return archive.read(info)

    def readable(self, raw):
        source = source_path(raw)
        if source is None or not source.exists():
            return False, "Download this book in Apple Books on your Mac first."
        if source.suffix.lower() != ".epub":
            return False, "Only EPUB books can be read here yet."
        try:
            ElementTree.fromstring(self.entry(source, "META-INF/container.xml", 1024 * 1024))
            for marker in ("META-INF/sinf.xml", "META-INF/rights.xml"):
                try:
                    self.entry(source, marker)
                    return False, "This book has copy protection and cannot be opened here."
                except KeyError:
                    pass
            try:
                encryption = ElementTree.fromstring(self.entry(source, "META-INF/encryption.xml"))
                methods = {el.attrib.get("Algorithm") for el in encryption.iter()
                           if el.tag.endswith("EncryptionMethod")}
                if methods - FONT_ENCRYPTION:
                    return False, "This book has copy protection and cannot be opened here."
            except KeyError:
                pass
        except BookNotDownloadedError as error:
            return False, str(error)
        except (OSError, KeyError, ValueError, zipfile.BadZipFile, ElementTree.ParseError):
            return False, "This EPUB is incomplete or unreadable. Download it again in Books."
        return True, None

    @staticmethod
    def apple_position(annotations):
        row = next((row for row in annotations if row.get("ZANNOTATIONTYPE") == 3
                    and (row.get("ZANNOTATIONLOCATION") or "").startswith("epubcfi(")), None)
        if row is None:
            return None
        cfi = row["ZANNOTATIONLOCATION"]
        stamp = row.get("ZANNOTATIONMODIFICATIONDATE")
        revision = hashlib.sha256(json.dumps([cfi, stamp]).encode()).hexdigest()[:24]
        return {"cfi": cfi, "updatedAt": apple_date(stamp), "revision": revision}

    def web_position(self, book_id, db=None):
        if db is None:
            with self.state_connection() as connection:
                return self.web_position(book_id, connection)
        row = db.execute("SELECT * FROM positions WHERE book_id=?", (book_id,)).fetchone()
        if row is None:
            return None
        return {"cfi": row["cfi"], "savedAt": row["saved_at"], "revision": row["revision"],
                "clientId": row["client_id"], "sequence": row["sequence"],
                "appleRevision": row["apple_revision"], "href": row["href"], "percentage": row["percentage"]}

    @staticmethod
    def sync_state(apple, web):
        if web:
            return "conflict" if web["appleRevision"] != (apple or {}).get("revision") else "pending"
        return "apple" if apple else "empty"

    def summary(self, raw, annotations):
        book_id = raw["ZASSETID"]
        apple = self.apple_position(annotations)
        web = self.web_position(book_id)
        available, reason = self.readable(raw)
        try:
            progress = min(1, max(0, float(raw.get("ZREADINGPROGRESS") or 0)))
        except (TypeError, ValueError):
            progress = 0
        if web and web["percentage"] is not None:
            progress = web["percentage"]
        last_read = max(filter(None, [apple_date(raw.get("ZLASTOPENDATE")),
                                      apple_date(raw.get("ZLASTENGAGEDDATE")),
                                      (web or {}).get("savedAt")]), default=None)
        return {"id": book_id, "title": raw.get("ZTITLE") or "Untitled", "author": raw.get("ZAUTHOR") or "Unknown author",
                "progress": progress, "lastReadAt": last_read, "readable": available, "unavailableReason": reason,
                "coverUrl": f"/api/books/{quote(book_id, safe='')}/cover" if available else None,
                "syncState": self.sync_state(apple, web)}

    def list_books(self):
        annotations = {}
        for row in self.raw_annotations():
            annotations.setdefault(row.get("ZANNOTATIONASSETID"), []).append(row)
        books = [self.summary(row, annotations.get(row["ZASSETID"], [])) for row in self.raw_books()]
        books.sort(key=lambda book: (book["lastReadAt"] or "", book["title"]), reverse=True)
        return {"books": books, "refreshedAt": now(), "bridge": "local"}

    def book(self, book_id):
        raw = self.raw_book(book_id)
        annotations = self.raw_annotations(book_id)
        result = self.summary(raw, annotations)
        apple = self.apple_position(annotations)
        web = self.web_position(book_id)
        chosen = web or apple
        result.update({"epubUrl": f"/api/books/{quote(book_id, safe='')}/epub",
                       "appleBooksUrl": f"ibooks://assetid/{quote(book_id, safe='')}", "applePosition": apple, "webPosition": web,
                       "resume": {"cfi": (chosen or {}).get("cfi"), "source": "web" if web else "apple" if apple else "start"},
                       "annotations": []})
        # Observed Apple annotation styles; see py-apple-books/models/annotation.py.
        colors = {1: "green", 2: "blue", 3: "yellow", 4: "pink", 5: "purple"}
        for row in annotations:
            kind, cfi = row.get("ZANNOTATIONTYPE"), row.get("ZANNOTATIONLOCATION")
            if kind not in (1, 2) or not cfi or not cfi.startswith("epubcfi("):
                continue
            result["annotations"].append({"id": row.get("ZANNOTATIONUUID") or str(row["Z_PK"]),
                "type": "highlight" if kind == 2 else "bookmark", "cfi": cfi,
                "text": row.get("ZANNOTATIONSELECTEDTEXT") or row.get("ZANNOTATIONREPRESENTATIVETEXT") or "",
                "note": row.get("ZANNOTATIONNOTE") or "", "color": colors.get(row.get("ZANNOTATIONSTYLE"), "yellow")})
        return result

    def save_position(self, book_id, payload):
        if not isinstance(payload, dict):
            raise ValueError("Expected a reading position")
        cfi = payload.get("cfi")
        if not isinstance(cfi, str) or len(cfi) > 8192 or not re.fullmatch(r"epubcfi\([^\x00-\x1f]+\)", cfi):
            raise ValueError("Expected an EPUB reading position")
        client = payload.get("clientId")
        sequence, base_revision = payload.get("sequence"), payload.get("baseRevision")
        if not isinstance(client, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", client):
            raise ValueError("Expected a reader session identifier")
        if any(type(number) is not int or not 0 <= number <= 9007199254740991 for number in (sequence, base_revision)):
            raise ValueError("Expected valid position revision numbers")
        percentage = payload.get("percentage")
        if percentage is not None and (type(percentage) not in (int, float) or not math.isfinite(percentage) or not 0 <= percentage <= 1):
            raise ValueError("Reading percentage must be between zero and one")
        href = payload.get("href")
        if href is not None and (not isinstance(href, str) or len(href) > 2048):
            raise ValueError("Invalid chapter reference")
        with self.lock, self.state_connection() as db:
            book = self.book(book_id)
            # A browser may still have its saved EPUB after Books removes the
            # Mac download. Progress needs the library identity, not file bytes.
            previous = self.web_position(book_id, db)
            if previous and previous["clientId"] == client and sequence <= previous["sequence"]:
                return {"ok": True, "position": previous, "syncState": book["syncState"], "ignored": True}
            apple_revision = (book["applePosition"] or {}).get("revision")
            if payload.get("appleRevision") != apple_revision:
                raise ConflictError("Apple Books has a newer position. Choose where to continue.", book)
            revision = previous["revision"] if previous else 0
            if (not previous or previous["clientId"] != client) and base_revision != revision:
                raise ConflictError("Another reader saved a newer position. Choose where to continue.", book)
            db.execute("""INSERT INTO positions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(book_id) DO UPDATE SET cfi=excluded.cfi, saved_at=excluded.saved_at,
                revision=excluded.revision, client_id=excluded.client_id, sequence=excluded.sequence,
                apple_revision=excluded.apple_revision, href=excluded.href, percentage=excluded.percentage""",
                (book_id, cfi, now(), revision + 1, client, sequence, apple_revision, href, percentage))
            return {"ok": True, "position": self.web_position(book_id, db), "syncState": "pending"}

    def epub(self, book_id):
        raw = self.raw_book(book_id)
        available, reason = self.readable(raw)
        if not available:
            raise ValueError(reason)
        source = source_path(raw)
        folder = self.data_root / "books"
        folder.mkdir(mode=0o700, exist_ok=True)
        digest = hashlib.sha256(book_id.encode()).hexdigest()
        destination = folder / f"{digest}.epub"
        with self.lock:
            if not destination.exists() or destination.stat().st_mtime < source.stat().st_mtime:
                if source.is_dir():
                    for member in source.rglob("*"):
                        if getattr(member.stat(), "st_flags", 0) & SF_DATALESS:
                            raise BookNotDownloadedError("Finish downloading this book in Apple Books on your Mac first.")
                        if member.is_file() and not member.resolve().is_relative_to(source.resolve()):
                            raise ValueError("EPUB package contains an external file link")
                temporary = folder / f"{digest}.tmp"
                try:
                    copy_epub(source, temporary)
                    temporary.replace(destination)
                finally:
                    temporary.unlink(missing_ok=True)
        return destination

    def cover(self, book_id):
        raw = self.raw_book(book_id)
        available, reason = self.readable(raw)
        if not available:
            raise KeyError(reason)
        source = source_path(raw)
        container = ElementTree.fromstring(self.entry(source, "META-INF/container.xml"))
        rootfile = next((el.attrib.get("full-path") for el in container.iter() if el.tag.endswith("rootfile")), None)
        if not rootfile:
            raise KeyError("No EPUB package document")
        package = ElementTree.fromstring(self.entry(source, rootfile))
        items = [el for el in package.iter() if el.tag.endswith("}item") or el.tag == "item"]
        cover_id = next((el.attrib.get("content") for el in package.iter()
                         if el.tag.endswith("meta") and el.attrib.get("name") == "cover"), None)
        item = next((el for el in items if "cover-image" in el.attrib.get("properties", "").split()), None)
        if item is None and cover_id:
            item = next((el for el in items if el.attrib.get("id") == cover_id), None)
        if item is None:
            raise KeyError("No cover image in this EPUB")
        href = item.attrib.get("href", "")
        member = posixpath.normpath(posixpath.join(posixpath.dirname(rootfile), href))
        mime = item.attrib.get("media-type") or mimetypes.guess_type(member)[0]
        if mime not in ("image/jpeg", "image/png", "image/gif", "image/webp"):
            raise KeyError("No supported cover image")
        return self.entry(source, member), mime
