"""Ask Books to open a saved position, then verify its own read-only record."""

import re
import threading
import time
from datetime import datetime
from urllib.parse import quote


_IDENTIFIER = re.compile(r"[A-Za-z0-9._:-]{1,200}")
_STEPS = re.compile(r"(?:/[1-9][0-9]*)+")
_OFFSET = re.compile(r"(?:0|[1-9][0-9]*)")
_MAX_NUMBER = 2_147_483_647
_READBACK_SECONDS = 5.0


def _without_assertions(value):
    result = []
    assertion = escaped = False
    for character in value:
        if escaped:
            escaped = False
        elif assertion and character == "^":
            escaped = True
        elif character == "[":
            if assertion:
                raise ValueError("Invalid EPUB position assertion")
            assertion = True
        elif character == "]":
            if not assertion:
                raise ValueError("Invalid EPUB position assertion")
            assertion = False
        elif not assertion:
            result.append(character)
    if assertion or escaped:
        raise ValueError("Invalid EPUB position assertion")
    return "".join(result)


def _point(value):
    if value.count("!") != 1 or value.count(":") > 1:
        raise ValueError("Invalid EPUB reading position")
    package, content = value.split("!")
    parts = content.split(":")
    if not _STEPS.fullmatch(package) or not _STEPS.fullmatch(parts[0]):
        raise ValueError("Invalid EPUB reading position")
    if len(parts) == 2 and not _OFFSET.fullmatch(parts[1]):
        raise ValueError("Invalid EPUB character offset")
    package_steps = tuple(map(int, package.split("/")[1:]))
    content_steps = tuple(map(int, parts[0].split("/")[1:]))
    offset = int(parts[1]) if len(parts) == 2 else 0
    if (len(package_steps) != 2 or package_steps[0] != 6 or package_steps[1] % 2
            or len(content_steps) > 256 or max((*package_steps, *content_steps, offset)) > _MAX_NUMBER):
        raise ValueError("EPUB position is outside supported bounds")
    return package_steps, content_steps, offset


def _location(cfi):
    """Compare the first text node; Books may save its visible-page offset."""
    if (not isinstance(cfi, str) or len(cfi) > 8192 or not cfi.startswith("epubcfi(")
            or not cfi.endswith(")") or any(ord(character) < 32 or ord(character) == 127 for character in cfi)):
        raise ValueError("Invalid EPUB reading position")
    parts = _without_assertions(cfi[8:-1]).split(",")
    if len(parts) == 1:
        return _point(parts[0])
    if len(parts) != 3 or not all(parts) or ":" in parts[0]:
        raise ValueError("Invalid EPUB position range")
    start, end = (_point(parts[0] + endpoint) for endpoint in parts[1:])
    if end < start:
        raise ValueError("EPUB position range runs backwards")
    return start


def _open_url(url, timeout=5.0):
    # AppKit documents this asynchronous operation as safe from any thread;
    # its completion runs on a concurrent queue. No Apple Events are sent.
    import AppKit
    import Foundation
    import objc

    with objc.autorelease_pool():
        target = Foundation.NSURL.URLWithString_(url)
        if target is None:
            return False
        configuration = AppKit.NSWorkspaceOpenConfiguration.configuration()
        configuration.setActivates_(False)
        configuration.setAddsToRecentItems_(False)
        completed = threading.Event()
        outcome = []

        def finish(application, error):
            outcome.append(application is not None and error is None)
            completed.set()

        AppKit.NSWorkspace.sharedWorkspace().openURL_configuration_completionHandler_(target, configuration, finish)
        return completed.wait(timeout) and bool(outcome and outcome[0])


def _fresh_position(actual, previous):
    if not actual:
        return False
    try:
        current = datetime.fromisoformat(actual["updatedAt"].replace("Z", "+00:00"))
        old = datetime.fromisoformat(previous["updatedAt"].replace("Z", "+00:00")) if previous else None
        return old is None or current > old
    except (KeyError, TypeError, ValueError, AttributeError):
        return False


def apply_position(library, book_id, cfi, *, opener=None, sleep=time.sleep, clock=time.monotonic,
                   cancelled=lambda: False):
    """Return Books' verified position, or None if it has not saved the jump.

    The caller keeps unconfirmed revisions pending. Only Books writes its
    private stores; this function reads the requested book's existing records.
    """
    if not isinstance(book_id, str) or not _IDENTIFIER.fullmatch(book_id):
        raise ValueError("Invalid book identifier")
    target = _location(cfi)
    opener = opener or _open_url
    try:
        if cancelled():
            return None
        raw = library.raw_book(book_id)
        if not library.readable(raw)[0]:
            return None
        previous = library.apple_position(library.raw_annotations(book_id))
        previous_location = None
        if previous:
            try:
                previous_location = _location(previous.get("cfi"))
                if previous_location == target:
                    return previous
            except ValueError:
                pass
        url = f"ibooks://assetid/{quote(book_id, safe='')}#{quote(cfi, safe='()/!,;:=@')}"
        # Books can close an already-open reader on the first URL delivery.
        # One retry allows its library window to open the requested passage.
        for _ in range(2):
            if cancelled():
                return None
            if not opener(url):
                continue
            deadline = clock() + _READBACK_SECONDS
            while True:
                if cancelled():
                    return None
                actual = library.apple_position(library.raw_annotations(book_id))
                if _fresh_position(actual, previous):
                    try:
                        actual_location = _location(actual.get("cfi"))
                        # Closing an existing reader can update only its save
                        # timestamp. Offset rounding is evidence of a jump only
                        # when Books also moved to a different text node.
                        moved_node = actual_location[:2] != (previous_location[:2] if previous_location else None)
                        if actual_location == target or actual_location[:2] == target[:2] and moved_node:
                            return actual
                    except ValueError:
                        pass
                remaining = deadline - clock()
                if remaining <= 0:
                    break
                sleep(min(0.25, remaining))
    except (KeyError, OSError, RuntimeError, ValueError):
        return None
    return None
