"""Experimental access to just the two Apple Books folders selected by the user."""

import base64
import json
import os
import stat
import tempfile
import threading
from pathlib import Path

from companion import RUNTIME, CompanionError


ACCESS_FILE = RUNTIME / ".local/folder-access.json"
BOOKS_FOLDERS = (
    Path.home() / "Library/Containers/com.apple.iBooksX/Data/Documents",
    Path.home() / "Library/Mobile Documents/iCloud~com~apple~iBooks/Documents",
)
MAX_BOOKMARK_BYTES = 64 * 1024
MAX_FILE_BYTES = 192 * 1024
_ACTIVE_URLS = {}


def _cocoa():
    try:
        import AppKit
        import Foundation
    except ImportError:
        raise CompanionError("Books folder access needs Cocoa support. Reinstall the companion dependencies first.") from None
    return AppKit, Foundation


def _invalid():
    return CompanionError("Saved Books folder access is invalid. Authorize the Books folders again.")


def _validate_record(record):
    if (not isinstance(record, dict) or set(record) != {"version", "folders"}
            or type(record["version"]) is not int or record["version"] != 1
            or not isinstance(record["folders"], list) or len(record["folders"]) != len(BOOKS_FOLDERS)):
        raise _invalid()
    bookmarks = []
    for entry, expected in zip(record["folders"], BOOKS_FOLDERS):
        if (not isinstance(entry, dict) or set(entry) != {"path", "bookmark"}
                or entry["path"] != str(expected) or not isinstance(entry["bookmark"], str)):
            raise _invalid()
        try:
            bookmark = base64.b64decode(entry["bookmark"], validate=True)
        except (ValueError, TypeError):
            raise _invalid() from None
        if not bookmark or len(bookmark) > MAX_BOOKMARK_BYTES:
            raise _invalid()
        bookmarks.append((expected, bookmark))
    return bookmarks


def _check_file(info):
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & 0o777 != 0o600):
        raise CompanionError("Saved Books folder access must be a regular file owned by you with permissions 0600.")


def _load_record(path):
    path = Path(path)
    try:
        _check_file(path.lstat())
    except FileNotFoundError:
        return None
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as source:
        _check_file(os.fstat(source.fileno()))
        data = source.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise _invalid()
    try:
        record = json.loads(data)
    except (ValueError, UnicodeError):
        raise _invalid() from None
    _validate_record(record)
    return record


def _save_record(record, path):
    _validate_record(record)
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    parent = path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid():
        raise CompanionError("Books folder access must be saved in your companion's private directory.")
    path.parent.chmod(0o700)
    try:
        _check_file(path.lstat())
    except FileNotFoundError:
        pass
    descriptor, temporary = tempfile.mkstemp(prefix=".folder-access-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(record, output, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _matches_folder(url, expected):
    # Purely lexical: probing these protected folders before selection can itself prompt.
    if url is None or not url.isFileURL():
        return False
    selected = url.path()
    return isinstance(selected, str) and os.path.normpath(selected) == os.path.normpath(str(expected))


def _retain_url(expected, url):
    # Unsandboxed inferred consent may not need a dynamic security scope.
    # A false return is not proof of persistent access; actual reads establish that.
    started = bool(url.startAccessingSecurityScopedResource())
    previous = _ACTIVE_URLS.get(str(expected))
    _ACTIVE_URLS[str(expected)] = (url, started)
    if previous and previous[1]:
        previous[0].stopAccessingSecurityScopedResource()


def authorize_folders(path=ACCESS_FILE):
    """Ask for the exact Books directories; return False on user cancellation."""
    if threading.current_thread() is not threading.main_thread():
        raise CompanionError("The Books folder picker must run on the main thread.")
    AppKit, Foundation = _cocoa()
    app = AppKit.NSApplication.sharedApplication()
    app.setActivationPolicy_(AppKit.NSApplicationActivationPolicyAccessory)
    app.activateIgnoringOtherApps_(True)
    selections = []
    for index, expected in enumerate(BOOKS_FOLDERS):
        while True:
            panel = AppKit.NSOpenPanel.openPanel()
            panel.setTitle_("Allow Apple Books library access" if index == 0 else "Allow Apple Books EPUB access")
            panel.setMessage_(
                f"Allow this exact Books folder:\n{expected}\n\n"
                "If macOS opens your general Documents folder instead, press Command-Shift-G, "
                "paste the path above, and press Return. Then choose Allow this folder without opening a subfolder.")
            panel.setPrompt_("Allow this folder")
            panel.setCanChooseDirectories_(True)
            panel.setCanChooseFiles_(False)
            panel.setAllowsMultipleSelection_(False)
            panel.setCanCreateDirectories_(False)
            panel.setDirectoryURL_(Foundation.NSURL.fileURLWithPath_isDirectory_(str(expected), True))
            if panel.runModal() != AppKit.NSModalResponseOK:
                return False
            url = panel.URL()
            if _matches_folder(url, expected):
                break
            alert = AppKit.NSAlert.alloc().init()
            alert.setMessageText_("Select the Apple Books folder shown")
            alert.setInformativeText_(
                f"This companion only accepts:\n{expected}\n\n"
                "Choose Try Again, press Command-Shift-G, and paste this exact path. "
                "Choose Allow this folder without opening a subfolder.")
            alert.addButtonWithTitle_("Try Again")
            alert.addButtonWithTitle_("Cancel")
            if alert.runModal() != AppKit.NSAlertFirstButtonReturn:
                return False
        # Keep the open-panel URL intact; reconstructing it from its path loses consent metadata.
        data, error = url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error_(0, None, None, None)
        if data is None or error is not None:
            raise CompanionError("macOS could not save access to the selected Books folder. Try authorizing again.")
        selections.append((expected, url, bytes(data)))
    record = {"version": 1, "folders": [
        {"path": str(expected), "bookmark": base64.b64encode(data).decode("ascii")}
        for expected, url, data in selections
    ]}
    _save_record(record, path)
    for expected, url, data in selections:
        _retain_url(expected, url)
    return True


def restore_folder_access(path=ACCESS_FILE):
    """Restore explicit folder choices without UI; persistence remains an experiment."""
    record = _load_record(path)
    if record is None:
        return
    _, Foundation = _cocoa()
    options = (Foundation.NSURLBookmarkResolutionWithoutUI
               | Foundation.NSURLBookmarkResolutionWithoutImplicitStartAccessing)
    resolved = []
    for expected, bookmark in _validate_record(record):
        data = Foundation.NSData.dataWithBytes_length_(bookmark, len(bookmark))
        url, stale, error = Foundation.NSURL.URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error_(
            data, options, None, None, None)
        if error is not None or stale or not _matches_folder(url, expected):
            raise _invalid()
        resolved.append((expected, url))
    for expected, url in resolved:
        _retain_url(expected, url)
