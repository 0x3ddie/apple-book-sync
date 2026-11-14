"""Copy one downloaded EPUB and read its saved position, without modifying Books."""

import argparse
import base64
import json
import shutil
import sqlite3
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parent
DATA = ROOT / ".local"
BOOKS = Path.home() / "Library/Containers/com.apple.iBooksX/Data/Documents"


def connect(folder, pattern):
    paths = list((BOOKS / folder).glob(pattern))
    if len(paths) != 1:
        raise RuntimeError(f"Expected one {folder} database, found {len(paths)}")
    connection = sqlite3.connect(paths[0].as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def json_default(value):
    if isinstance(value, bytes):
        return {"base64": base64.b64encode(value).decode()}
    raise TypeError(type(value).__name__)


def snapshot(title):
    with connect("BKLibrary", "*.sqlite") as library:
        rows = library.execute(
            "SELECT * FROM ZBKLIBRARYASSET WHERE ZTITLE = ?", (title,)
        ).fetchall()
    if len(rows) != 1:
        raise RuntimeError(f"Expected exactly one library entry for {title!r}, found {len(rows)}")
    book = dict(rows[0])
    with connect("AEAnnotation", "*.sqlite") as annotations:
        locations = annotations.execute(
            "SELECT * FROM ZAEANNOTATION WHERE ZANNOTATIONASSETID = ? "
            "AND ZANNOTATIONTYPE = 3 AND ZANNOTATIONDELETED IS NOT 1 "
            "ORDER BY ZANNOTATIONMODIFICATIONDATE DESC, Z_PK DESC",
            (book["ZASSETID"],),
        ).fetchall()
    if not locations or not locations[0]["ZANNOTATIONLOCATION"]:
        raise RuntimeError("No automatic reading-position CFI found; do not infer one from highlights")
    return {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "book": book,
        "locations": [dict(row) for row in locations],
    }


def copy_epub(source, destination):
    if source.is_dir():
        if not (source / "META-INF/container.xml").is_file():
            raise RuntimeError("Selected book is not a downloaded EPUB package")
        with zipfile.ZipFile(destination, "w") as archive:
            archive.writestr("mimetype", b"application/epub+zip", zipfile.ZIP_STORED)
            for path in sorted(source.rglob("*")):
                if path.is_file() and path.name != "mimetype":
                    archive.write(path, path.relative_to(source).as_posix(), zipfile.ZIP_DEFLATED)
    elif source.is_file() and zipfile.is_zipfile(source):
        shutil.copyfile(source, destination)
    else:
        raise RuntimeError(f"Book is not downloaded as a readable EPUB: {source}")
    with zipfile.ZipFile(destination) as archive:
        if archive.read("mimetype").strip() != b"application/epub+zip":
            raise RuntimeError("File is not an EPUB")
        if "META-INF/encryption.xml" in archive.namelist():
            encryption = ElementTree.fromstring(archive.read("META-INF/encryption.xml"))
            algorithms = {node.attrib.get("Algorithm") for node in encryption.iter()
                          if node.tag.endswith("EncryptionMethod")}
            font_obfuscation = {"http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"}
            if algorithms - font_obfuscation:
                raise RuntimeError("Book uses content encryption; select a DRM-free EPUB")
        if archive.testzip() is not None:
            raise RuntimeError("EPUB archive integrity check failed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("title")
    parser.add_argument("--snapshot-only", metavar="NAME", help="Save a later comparison without replacing the original")
    args = parser.parse_args()
    data = snapshot(args.title)
    DATA.mkdir(mode=0o700, exist_ok=True)
    cfi = data["locations"][0]["ZANNOTATIONLOCATION"]
    if args.snapshot_only:
        if Path(args.snapshot_only).name != args.snapshot_only:
            parser.error("Snapshot name must be a plain filename")
        output = DATA / args.snapshot_only
    else:
        output = DATA / "original-position.json"
        if output.exists():
            raise RuntimeError("Original position already captured; preserve it and use --snapshot-only")
        path = data["book"]["ZPATH"]
        source = Path(unquote(urlparse(path).path) if path.startswith("file:") else path)
        copy_epub(source, DATA / "book.epub")
        (DATA / "book.json").write_text(json.dumps({
            "title": args.title,
            "assetId": data["book"]["ZASSETID"],
            "originalCfi": cfi,
            "epubUrl": "/book.epub",
        }, indent=2))
    output.write_text(json.dumps(data, indent=2, default=json_default))
    print(json.dumps({"snapshot": str(output), "title": args.title, "cfi": cfi}))
