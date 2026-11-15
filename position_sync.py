"""Apply pending web positions on this Mac and acknowledge verified read-back."""

import asyncio
import re
import threading
import time
from datetime import datetime

from companion import CompanionError, MAX_SEQUENCE


DEBOUNCE_SECONDS = 5
RETRY_SECONDS = 60
MAX_PER_POLL = 3


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
            applied = position.get("applied")
            if applied is not None:
                if not isinstance(applied, dict) or not _identifier(applied.get("deviceId")):
                    raise ValueError("Invalid applied position")
                _timestamp(applied.get("at"))
                _apple_position(applied.get("applePosition"))
                if applied["deviceId"] == device_id:
                    continue
            if item.get("syncState", "pending") != "pending":
                continue
            result.append({"key": (item["bookId"], revision, position["cfi"]), "saved": saved})
    except (ValueError, TypeError, OverflowError):
        raise CompanionError("The sync service returned invalid pending positions.") from None
    return sorted(result, key=lambda item: (item["saved"], item["key"][1]), reverse=True)


class PositionSync:
    def __init__(self, client, library, *, device_id, apply=None, clock=time.time):
        self.client, self.library = client, library
        self.device_id, self.apply, self.clock = device_id, apply, clock
        self.cancelled = threading.Event()
        self.receipts = {}
        self.retry_after = {}

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
            from progress import apply_position
            apply = apply_position
        return apply(self.library, book_id, cfi, cancelled=self.cancelled.is_set)

    async def poll(self):
        if self.cancelled.is_set():
            return
        response = await asyncio.to_thread(self._request, "GET", "/api/companion/positions")
        if self.cancelled.is_set():
            return
        pending = _pending(response, self.device_id)
        current = {item["key"] for item in pending}
        self.receipts = {key: value for key, value in self.receipts.items() if key in current}
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
                    observed = await asyncio.to_thread(self._apply, book_id, cfi)
                    if self.cancelled.is_set():
                        return
                    observed = _apple_position(observed)
                except (OSError, RuntimeError, ValueError, TypeError):
                    self.retry_after[key] = self.clock() + RETRY_SECONDS
                    continue
                self.receipts[key] = observed
            if self.cancelled.is_set():
                return
            try:
                result = await asyncio.to_thread(self._request, "POST", f"/api/companion/positions/{book_id}/applied", {
                    "revision": revision, "cfi": cfi, "applePosition": self.receipts[key],
                })
                if self.cancelled.is_set():
                    return
                if not isinstance(result, dict) or result.get("ok") is not True or result.get("revision") != revision:
                    raise CompanionError("The sync service did not confirm the saved position.")
            except CompanionError as error:
                if error.status == 409:
                    self.receipts.pop(key, None)
                    self.retry_after.pop(key, None)
                    continue
                # Keep verified read-back after a failed ACK. The next poll can
                # acknowledge it without reopening or resetting Apple Books.
                raise
            self.receipts.pop(key, None)
            self.retry_after.pop(key, None)
            print("Reading position synced to Apple Books.", flush=True)
