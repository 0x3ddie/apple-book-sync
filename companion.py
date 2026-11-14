"""Pair this Mac and send Apple Books metadata; never upload EPUBs or edit Books."""

import argparse
import fcntl
import getpass
import hashlib
import json
import math
import os
import sqlite3
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from contextlib import contextmanager
from urllib.parse import urlsplit

from library import BooksLibrary


RUNTIME = Path.home() / "Library/Application Support/Apple Books Companion"
CONFIG = RUNTIME / ".local/companion.json"
LEGACY_CONFIG = Path(__file__).resolve().parent / ".local/companion.json"
MAX_BODY = 1024 * 1024
MAX_BOOKS = 200
MAX_SEQUENCE = 9007199254740991


class CompanionError(Exception):
    """An actionable error whose message contains no credentials."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def server_origin(value, allow_local_http=False):
    if not isinstance(value, str):
        raise CompanionError("Use the sync website's HTTPS origin, without a path.")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError):
        raise CompanionError("Use the sync website's HTTPS origin, without a path.") from None
    if (not parsed.hostname or parsed.username is not None or parsed.password is not None
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment
            or any(character.isspace() for character in value)
            or "\\" in value or port == 0):
        raise CompanionError("Use the sync website's HTTPS origin, without a path or credentials.")
    if parsed.scheme != "https" and not (
            parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and allow_local_http):
        raise CompanionError("HTTPS is required. Local development requires --allow-local-http and 127.0.0.1.")
    return f"{parsed.scheme}://{parsed.netloc}".rstrip("/")


def encode(payload):
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise CompanionError("The sync service redirected the request. Check its URL; no credentials were forwarded.")


class SyncClient:
    def __init__(self, server, credential=None, allow_local_http=False, opener=None):
        self.server = server_origin(server, allow_local_http)
        if credential is not None and (not isinstance(credential, str) or not 16 <= len(credential) <= 1024
                                       or not all(32 < ord(char) < 127 for char in credential)):
            raise CompanionError("The saved device credential is invalid. Pair this Mac again.")
        self.credential = credential
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def request(self, method, path, payload=None):
        if not path.startswith("/api/") or "?" in path or "#" in path:
            raise CompanionError("Invalid sync endpoint.")
        body = encode(payload) if payload is not None else None
        if body is not None and len(body) > MAX_BODY:
            raise CompanionError("A metadata request exceeds the 1 MiB limit.")
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if self.credential:
            headers["Authorization"] = f"Bearer {self.credential}"
        request = urllib.request.Request(self.server + path, data=body, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=20) as response:
                content = response.read(MAX_BODY + 1)
                if len(content) > MAX_BODY:
                    raise CompanionError("The sync service returned too much data.")
                result = json.loads(content)
        except urllib.error.HTTPError as error:
            raise CompanionError(f"The sync service returned HTTP {error.code}. Check the website's device settings.", status=error.code) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise CompanionError("Could not reach the sync service. Check the connection and server URL.") from None
        except (ValueError, UnicodeError):
            raise CompanionError("The sync service returned an invalid response.") from None
        if not isinstance(result, dict):
            raise CompanionError("The sync service returned an invalid response.")
        return result


def read_config(path=CONFIG):
    path = Path(path)
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
            raise CompanionError("The companion config must be an owned regular file with permissions 0600.")
        config = json.loads(path.read_text())
    except FileNotFoundError:
        raise CompanionError("This Mac is not paired. Run companion.py pair first.") from None
    except (ValueError, UnicodeError):
        raise CompanionError("The companion config is invalid. Pair this Mac again.") from None
    if not isinstance(config, dict) or not isinstance(config.get("deviceId"), str):
        raise CompanionError("The companion config is invalid. Pair this Mac again.")
    config["server"] = server_origin(config.get("server"), config.get("allowLocalHttp") is True)
    SyncClient(config["server"], config.get("credential"), config.get("allowLocalHttp") is True)
    if not config.get("credential") or type(config.get("sequence")) is not int or not 0 <= config["sequence"] < MAX_SEQUENCE:
        raise CompanionError("The companion config is invalid. Pair this Mac again.")
    return config


def write_config(config, path=CONFIG):
    path = Path(path)
    if path.parent.is_symlink():
        raise CompanionError("The companion config directory cannot be a symbolic link.")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    fd, temporary = tempfile.mkstemp(prefix=".companion-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(encode(config))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def config_lock(path=CONFIG):
    path = Path(path)
    if path.parent.is_symlink():
        raise CompanionError("The companion config directory cannot be a symbolic link.")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path.with_suffix(".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def migrate_legacy_config(source=LEGACY_CONFIG, target=CONFIG):
    """Keep one pairing when upgrading from a checkout-local installation."""
    source, target = Path(source), Path(target)
    if source == target or not source.exists():
        return
    with config_lock(target):
        if target.exists():
            return  # Never replace an existing installation's identity.
        config = read_config(source)
        write_config(config, target)
        source.unlink()


def metadata_book(detail):
    """An explicit allowlist: source paths, URLs, files, and web credentials never leave the Mac."""
    def string(value, field, default=None):
        if value is None and default is not None:
            return default
        if not isinstance(value, str):
            raise CompanionError(f"Invalid book metadata: {field} must be text.")
        return value

    progress = detail.get("progress", 0)
    if type(progress) not in (int, float) or not math.isfinite(progress) or not 0 <= progress <= 1:
        raise CompanionError("Invalid book metadata: reading progress must be between zero and one.")
    last_read = detail.get("lastReadAt")
    if last_read is not None:
        last_read = string(last_read, "lastReadAt")
    apple = detail.get("applePosition")
    if apple is not None:
        if not isinstance(apple, dict):
            raise CompanionError("Invalid Apple Books reading position.")
        apple = {"cfi": string(apple.get("cfi"), "cfi"),
                 "revision": string(apple.get("revision"), "revision"),
                 "updatedAt": string(apple.get("updatedAt"), "updatedAt") if apple.get("updatedAt") is not None else None}
    annotations = []
    source_annotations = detail.get("annotations", [])
    if not isinstance(source_annotations, list):
        raise CompanionError("Invalid Apple Books annotations.")
    for annotation in source_annotations:
        if not isinstance(annotation, dict) or annotation.get("type") not in ("highlight", "bookmark"):
            raise CompanionError("Invalid Apple Books annotation.")
        annotations.append({"id": string(annotation.get("id"), "annotation id"),
                            "type": annotation["type"], "cfi": string(annotation.get("cfi"), "annotation cfi"),
                            "text": string(annotation.get("text"), "annotation text", ""),
                            "note": string(annotation.get("note"), "annotation note", ""),
                            "color": string(annotation.get("color"), "annotation color", "yellow")})
    return {"id": string(detail.get("id"), "id"), "title": string(detail.get("title"), "title"),
            "author": string(detail.get("author"), "author", ""), "progress": progress,
            "lastReadAt": last_read, "availableOnMac": detail.get("readable") is True,
            "applePosition": apple, "annotations": annotations}


def snapshot_batches(books):
    batches, batch = [], []
    for book in books:
        candidate = batch + [book]
        if len(candidate) > MAX_BOOKS or len(encode({"sequence": MAX_SEQUENCE, "books": candidate})) > MAX_BODY:
            if not batch:
                raise CompanionError("One book's annotations exceed the 1 MiB limit; nothing was sent.")
            batches.append(batch)
            batch = []
            candidate = [book]
            if len(encode({"sequence": MAX_SEQUENCE, "books": candidate})) > MAX_BODY:
                raise CompanionError("One book's annotations exceed the 1 MiB limit; nothing was sent.")
        batch = candidate
    if batch:
        batches.append(batch)
    return batches


def pair(server, name, allow_local_http=False, path=CONFIG):
    server = server_origin(server, allow_local_http)
    if Path(path).exists():
        raise CompanionError("This Mac already has a pairing. Unpair locally before replacing it; revoke the old device on the website.")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100:
        raise CompanionError("Choose a device name between 1 and 100 characters.")
    if not sys.stdin.isatty():
        raise CompanionError("Run pairing in a terminal so its token can be entered without echoing.")
    token = getpass.getpass("Pairing token from the website (hidden): ").strip()
    if not 16 <= len(token) <= 1024:
        raise CompanionError("The pairing token is invalid. Copy a fresh token from the website.")
    result = SyncClient(server, allow_local_http=allow_local_http).request("POST", "/api/devices/claim", {"token": token, "name": name.strip()})
    device, credential = result.get("device"), result.get("credential")
    if not isinstance(device, dict) or not isinstance(device.get("id"), str) or not device["id"]:
        raise CompanionError("The sync service did not return a device identifier.")
    SyncClient(server, credential, allow_local_http)
    if credential is None:
        raise CompanionError("The sync service did not return a device credential.")
    config = {"server": server, "deviceId": device["id"], "name": name.strip(),
              "credential": credential, "sequence": 0, "allowLocalHttp": allow_local_http}
    write_config(config, path)
    print(f"Mac paired. Device credential saved in {path} with permissions 0600 (not Keychain).")


def sync(path=CONFIG, library=None, client=None, *, skip_unchanged=False, quiet=False):
    with config_lock(path):
        return _sync(path, library, client, skip_unchanged=skip_unchanged, quiet=quiet)


def _sync(path, library=None, client=None, *, skip_unchanged=False, quiet=False):
    config = read_config(path)
    client = client or SyncClient(config["server"], config["credential"], config.get("allowLocalHttp") is True)
    library = library or BooksLibrary()
    books = [metadata_book(library.book(book["id"])) for book in library.list_books()["books"]]
    batches = snapshot_batches(books)
    snapshot_hash = hashlib.sha256(encode(books)).hexdigest()
    if skip_unchanged and config.get("snapshotHash") == snapshot_hash:
        return {"changed": False, "books": len(books)}
    for batch in batches:
        # Reserve before sending, so a crash cannot reuse an acknowledged sequence.
        config["sequence"] = max(config["sequence"] + 1, time.time_ns() // 1_000_000)
        if config["sequence"] >= MAX_SEQUENCE:
            raise CompanionError("The device sequence is exhausted. Pair this Mac again.")
        write_config(config, path)
        result = client.request("POST", "/api/companion/snapshot", {"sequence": config["sequence"], "books": batch})
        if result.get("ignored"):
            known = result.get("sequence")
            if type(known) is int and config["sequence"] < known < MAX_SEQUENCE:
                config["sequence"] = known
                write_config(config, path)
            raise CompanionError("The server has a newer snapshot sequence. Run sync again to refresh it safely.")
    result = client.request("GET", "/api/companion/positions")
    positions = result.get("positions", [])
    if not isinstance(positions, list):
        raise CompanionError("The sync service returned invalid pending positions.")
    config["snapshotHash"] = snapshot_hash
    write_config(config, path)
    if not quiet:
        print(f"Sent metadata for {len(books)} books in {len(batches)} batches. {len(positions)} web positions awaiting Apple Books handoff.")
        print("EPUBs stayed on this Mac. Apple Books was not modified.")
    return {"changed": True, "books": len(books)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    pairing = commands.add_parser("pair", help="Pair using a token shown on your signed-in website")
    pairing.add_argument("--server", required=True, help="The HTTPS origin of your sync website")
    pairing.add_argument("--name", default="Mac companion")
    pairing.add_argument("--allow-local-http", action="store_true", help="Development only: permit http://127.0.0.1")
    commands.add_parser("sync", help="Send one metadata snapshot; does not change Apple Books")
    sharing = commands.add_parser("serve", help="Offer selected EPUBs directly to your devices on the same Wi-Fi")
    duration = sharing.add_mutually_exclusive_group()
    duration.add_argument("--minutes", type=int, default=30, help="How long to offer transfers (1–480; default 30 minutes)")
    duration.add_argument("--background", action="store_true", help="Run continuously for the macOS background service")
    commands.add_parser("status", help="Show pairing details without credentials")
    commands.add_parser("unpair", help="Remove the local credential; revoke the device separately on the website")
    arguments = parser.parse_args()
    try:
        migrate_legacy_config()
        if arguments.command == "pair":
            with config_lock():
                pair(arguments.server, arguments.name, arguments.allow_local_http)
        elif arguments.command == "sync":
            sync()
        elif arguments.command == "serve":
            if not 1 <= arguments.minutes <= 480:
                raise CompanionError("Choose a transfer window between 1 and 480 minutes.")
            try:
                import asyncio
                from transfer import serve_transfers
            except ImportError:
                raise CompanionError("Run ./scripts/start-transfers.sh to install the direct-transfer dependencies.") from None
            asyncio.run(serve_transfers(minutes=arguments.minutes, background=arguments.background))
        elif arguments.command == "status":
            config = read_config()
            print(f"Paired: {config.get('name', 'Mac companion')}\nServer: {config['server']}\nDevice: {config['deviceId']}\nLast reserved sequence: {config['sequence']}")
        else:
            with config_lock():
                read_config()
                CONFIG.unlink()
            print("Local pairing removed. Also revoke this device in the website's device settings.")
    except (CompanionError, OSError, RuntimeError, sqlite3.Error) as error:
        print(f"Companion: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nTransfers stopped. Books already saved on your phone remain available offline.")
        return 0
    return 0


if __name__ == "__main__":
    # transfer imports the same helpers; retain a single exception/config module
    # when this file was invoked as a script rather than imported.
    sys.modules["companion"] = sys.modules[__name__]
    raise SystemExit(main())
