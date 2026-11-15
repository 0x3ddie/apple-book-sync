"""Deliver web positions once, distinguishing dispatch from verified read-back."""

import asyncio
import json
import os
import re
import stat
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path

from companion import CompanionError, MAX_SEQUENCE


DEBOUNCE_SECONDS = 5
RETRY_SECONDS = 60
MAX_PER_POLL = 3
MAX_RECEIPTS_BYTES = 1024 * 1024


def _timestamp(value):
    if not isinstance(value, str) or len(value) > 40:
        raise ValueError("Invalid timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Missing timezone")
    return parsed.timestamp()


def _identifier(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", value)


def _cfi(value):
    return isinstance(value, str) and len(value) <= 8192 and re.fullmatch(r"epubcfi\([^\x00-\x1f]+\)", value)


def _apple_position(value):
    if not isinstance(value, dict) or not _cfi(value.get("cfi")):
        raise ValueError("Invalid Apple position")
    revision = value.get("revision")
    if not isinstance(revision, str) or not 1 <= len(revision) <= 200 or any(ord(char) < 32 for char in revision):
        raise ValueError("Invalid Apple revision")
    _timestamp(value.get("updatedAt"))
    return {field: value[field] for field in ("cfi", "revision", "updatedAt")}


def _receipt(value):
    if not isinstance(value, dict) or value.get("phase") not in ("applied", "delivered"):
        raise ValueError("Invalid position receipt")
    observed = value.get("applePosition")
    if observed is not None:
        observed = _apple_position(observed)
    elif value["phase"] == "applied":
        raise ValueError("Missing verified position")
    return {"phase": value["phase"], "applePosition": observed}


def _pending(response, device_id):
    if not isinstance(response, dict) or not isinstance(response.get("positions"), list):
        raise CompanionError("The sync service returned invalid pending positions.")
    result, seen = [], set()
    try:
        for item in response["positions"]:
            if not isinstance(item, dict) or not _identifier(item.get("bookId")) or item["bookId"] in seen:
                raise ValueError("Invalid book identifier")
            seen.add(item["bookId"])
            position = item.get("position")
            if not isinstance(position, dict) or not _cfi(position.get("cfi")):
                raise ValueError("Invalid web position")
            revision = position.get("revision")
            if type(revision) is not int or not 1 <= revision <= MAX_SEQUENCE:
                raise ValueError("Invalid web revision")
            saved = _timestamp(position.get("savedAt"))
            delivered_here = False
            for field in ("applied", "delivered"):
                marker = position.get(field)
                if marker is None:
                    continue
                if not isinstance(marker, dict) or not _identifier(marker.get("deviceId")):
                    raise ValueError("Invalid position receipt")
                _timestamp(marker.get("at"))
                _receipt({"phase": field, "applePosition": marker.get("applePosition")})
                delivered_here |= marker["deviceId"] == device_id
            if delivered_here:
                continue
            if item.get("syncState", "pending") != "pending":
                continue
            result.append({"key": (item["bookId"], revision, position["cfi"]), "saved": saved})
    except (ValueError, TypeError, OverflowError):
        raise CompanionError("The sync service returned invalid pending positions.") from None
    return sorted(result, key=lambda item: (item["saved"], item["key"][1]), reverse=True)


class PositionSync:
    def __init__(self, client, library, *, device_id, apply=None, clock=time.time, cache_path=None):
        self.client, self.library = client, library
        self.device_id, self.apply, self.clock = device_id, apply, clock
        self.cancelled = threading.Event()
        self.receipts = {}
        self.retry_after = {}
        self.cache_path = Path(cache_path) if cache_path is not None else None
        if not _identifier(device_id):
            raise CompanionError("The companion device identifier is invalid.")
        self.receipts = self._load_receipts()

    @staticmethod
    def _private_file(info):
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise CompanionError("The position receipt cache must be an owned private regular file.")

    def _load_receipts(self):
        if self.cache_path is None:
            return {}
        try:
            try:
                self._private_file(self.cache_path.lstat())
            except FileNotFoundError:
                return {}
            descriptor = os.open(self.cache_path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(descriptor, "rb") as source:
                self._private_file(os.fstat(source.fileno()))
                data = source.read(MAX_RECEIPTS_BYTES + 1)
            if len(data) > MAX_RECEIPTS_BYTES:
                raise ValueError("Oversized receipts")
            value = json.loads(data)
            if (not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1
                    or not _identifier(value.get("deviceId")) or not isinstance(value.get("receipts"), list)):
                raise ValueError("Invalid receipt cache")
            if value["deviceId"] != self.device_id:
                self._save_receipts()  # Re-pairing cannot replay another device's receipts.
                return {}
            receipts = {}
            for item in value["receipts"]:
                if (not isinstance(item, dict) or not _identifier(item.get("bookId")) or not _cfi(item.get("cfi"))
                        or type(item.get("revision")) is not int or not 1 <= item["revision"] <= MAX_SEQUENCE):
                    raise ValueError("Invalid cached target")
                key = (item["bookId"], item["revision"], item["cfi"])
                if key in receipts:
                    raise ValueError("Duplicate cached target")
                receipts[key] = _receipt(item)
            return receipts
        except (OSError, ValueError, TypeError, OverflowError):
            raise CompanionError("The position receipt cache could not be read safely.") from None

    def _save_receipts(self):
        if self.cache_path is None:
            return
        temporary = None
        try:
            directory = self.cache_path.parent.lstat()
            if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid() or directory.st_mode & 0o077:
                raise CompanionError("The position receipt cache needs a private companion directory.")
            try:
                self._private_file(self.cache_path.lstat())
            except FileNotFoundError:
                pass
            data = json.dumps({"version": 1, "deviceId": self.device_id, "receipts": [
                {"bookId": key[0], "revision": key[1], "cfi": key[2], **receipt}
                for key, receipt in self.receipts.items()
            ]}, separators=(",", ":"), allow_nan=False).encode()
            if len(data) > MAX_RECEIPTS_BYTES:
                raise ValueError("Oversized receipts")
            descriptor, temporary = tempfile.mkstemp(prefix=".progress-receipts-", dir=self.cache_path.parent)
            with os.fdopen(descriptor, "wb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.cache_path)
        except (OSError, ValueError):
            raise CompanionError("The position receipt could not be saved on this Mac.") from None
        finally:
            if temporary is not None:
                Path(temporary).unlink(missing_ok=True)

    def clear(self):
        self.cancelled.set()
        self.receipts.clear()
        self.retry_after.clear()

    def _request(self, method, endpoint, payload=None):
        if self.cancelled.is_set():
            return None
        return self.client.request(method, endpoint, payload) if payload is not None else self.client.request(method, endpoint)

    def _apply(self, book_id, cfi):
        if self.cancelled.is_set():
            return None
        apply = self.apply
        if apply is None:
            from progress import deliver_position
            apply = deliver_position
        return apply(self.library, book_id, cfi, cancelled=self.cancelled.is_set)

    async def poll(self):
        if self.cancelled.is_set():
            return
        response = await asyncio.to_thread(self._request, "GET", "/api/companion/positions")
        if self.cancelled.is_set():
            return
        pending = _pending(response, self.device_id)
        current = {item["key"] for item in pending}
        kept = {key: value for key, value in self.receipts.items() if key in current}
        if len(kept) != len(self.receipts):
            self.receipts = kept
            self._save_receipts()
        self.retry_after = {key: value for key, value in self.retry_after.items() if key in current}
        eligible = [item for item in pending if self.clock() - item["saved"] >= DEBOUNCE_SECONDS
                    and self.clock() >= self.retry_after.get(item["key"], 0)][:MAX_PER_POLL]
        for index, item in enumerate(eligible):
            if self.cancelled.is_set():
                return
            key = item["key"]
            book_id, revision, cfi = key
            if key not in self.receipts:
                # Recheck authorization and the target before opening another
                # book after a potentially slow native read-back.
                if index:
                    response = await asyncio.to_thread(self._request, "GET", "/api/companion/positions")
                    if self.cancelled.is_set():
                        return
                    if key not in {entry["key"] for entry in _pending(response, self.device_id)}:
                        continue
                try:
                    delivery = await asyncio.to_thread(self._apply, book_id, cfi)
                    if self.cancelled.is_set():
                        return
                    if (not isinstance(delivery, dict) or delivery.get("delivered") is not True
                            or type(delivery.get("confirmed")) is not bool):
                        raise ValueError("Position was not delivered")
                    receipt = _receipt({"phase": "applied" if delivery["confirmed"] else "delivered",
                                        "applePosition": delivery.get("applePosition")})
                except (OSError, RuntimeError, ValueError, TypeError):
                    self.retry_after[key] = self.clock() + RETRY_SECONDS
                    continue
                self.receipts[key] = receipt
            if self.cancelled.is_set():
                return
            # Persist the result before sending it. An offline ACK or process
            # restart must not reopen a position already delivered to Books.
            self._save_receipts()
            receipt = self.receipts[key]
            try:
                result = await asyncio.to_thread(self._request, "POST", f"/api/companion/positions/{book_id}/{receipt['phase']}", {
                    "revision": revision, "cfi": cfi, "applePosition": receipt["applePosition"],
                })
                if self.cancelled.is_set():
                    return
                if not isinstance(result, dict) or result.get("ok") is not True or result.get("revision") != revision:
                    raise CompanionError("The sync service did not confirm the saved position.")
            except CompanionError as error:
                if error.status == 409:
                    self.receipts.pop(key, None)
                    self.retry_after.pop(key, None)
                    self._save_receipts()
                    continue
                # Keep the durable delivery or read-back after a failed ACK.
                # The next poll can acknowledge it without reopening Books.
                raise
            self.receipts.pop(key, None)
            self.retry_after.pop(key, None)
            self._save_receipts()
            print("Reading position synced to Apple Books." if receipt["phase"] == "applied"
                  else "Reading position sent to Apple Books.", flush=True)
