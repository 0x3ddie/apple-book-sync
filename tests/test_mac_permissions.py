import base64
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from companion import CompanionError
from mac_permissions import BOOKS_FOLDERS, _load_record, _save_record, authorize_folders, restore_folder_access


class MacPermissionsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / ".local/folder-access.json"
        self.record = {"version": 1, "folders": [
            {"path": str(folder), "bookmark": base64.b64encode(f"bookmark-{index}".encode()).decode()}
            for index, folder in enumerate(BOOKS_FOLDERS)
        ]}
        self.active = self.enterContext(patch("mac_permissions._ACTIVE_URLS", {}))

    def test_private_atomic_storage_round_trip_and_no_credential_changes(self):
        self.path.parent.mkdir()
        pairing = self.path.with_name("companion.json")
        pairing.write_bytes(b"existing pairing")
        _save_record(self.record, self.path)
        self.assertEqual(_load_record(self.path), self.record)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.path.parent.stat().st_mode & 0o777, 0o700)
        _save_record(self.record, self.path)
        self.assertEqual(pairing.read_bytes(), b"existing pairing")
        self.assertFalse(list(self.path.parent.glob(".folder-access-*")))

    def test_other_folders_duplicates_and_bad_bookmarks_are_rejected_without_writing(self):
        for change in ("other-folder", "duplicate", "invalid-bookmark", "wrong-version"):
            with self.subTest(change=change):
                record = json.loads(json.dumps(self.record))
                if change == "other-folder":
                    record["folders"][0]["path"] = str(Path.home() / "Library")
                elif change == "duplicate":
                    record["folders"][1] = record["folders"][0]
                elif change == "invalid-bookmark":
                    record["folders"][0]["bookmark"] = "not base64!"
                else:
                    record["version"] = True
                with self.assertRaisesRegex(CompanionError, "invalid"):
                    _save_record(record, self.path)
                self.assertFalse(self.path.exists())

    def test_symlink_and_permissive_state_are_rejected(self):
        _save_record(self.record, self.path)
        self.path.chmod(0o644)
        with self.assertRaisesRegex(CompanionError, "0600"):
            _load_record(self.path)
        target = self.path.with_name("target.json")
        self.path.rename(target)
        self.path.symlink_to(target)
        for action in (lambda: _load_record(self.path), lambda: _save_record(self.record, self.path)):
            with self.assertRaisesRegex(CompanionError, "regular file"):
                action()
        self.assertEqual(json.loads(target.read_text()), self.record)

    def test_absent_state_does_not_import_cocoa(self):
        with patch("mac_permissions._cocoa") as cocoa:
            self.assertIsNone(restore_folder_access(self.path))
        cocoa.assert_not_called()

    def fake_cocoa(self, urls, responses=None):
        panels = []
        for index, url in enumerate(urls):
            panel = Mock()
            panel.runModal.return_value = (responses or [1] * len(urls))[index]
            panel.URL.return_value = url
            panels.append(panel)
        appkit = SimpleNamespace(
            NSApplication=Mock(), NSApplicationActivationPolicyAccessory=1,
            NSOpenPanel=SimpleNamespace(openPanel=Mock(side_effect=panels)), NSModalResponseOK=1,
            NSAlert=Mock(), NSAlertFirstButtonReturn=1000,
        )
        foundation = SimpleNamespace(
            NSURL=Mock(), NSData=Mock(), NSURLBookmarkResolutionWithoutUI=256,
            NSURLBookmarkResolutionWithoutImplicitStartAccessing=32768,
        )
        foundation.NSData.dataWithBytes_length_.side_effect = lambda data, length: data
        return appkit, foundation, panels

    def urls(self):
        urls = []
        for index, folder in enumerate(BOOKS_FOLDERS):
            url = Mock()
            url.isFileURL.return_value = True
            url.path.return_value = str(folder)
            url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error_.return_value = (
                f"bookmark-{index}".encode(), None)
            url.startAccessingSecurityScopedResource.return_value = False
            urls.append(url)
        return urls

    def test_cancel_second_picker_does_not_write_partial_state(self):
        appkit, foundation, panels = self.fake_cocoa(self.urls(), [1, 0])
        with patch("mac_permissions._cocoa", return_value=(appkit, foundation)):
            self.assertFalse(authorize_folders(self.path))
        self.assertFalse(self.path.exists())
        self.assertEqual(self.active, {})

    def test_exact_folder_selection_saves_plain_bookmarks(self):
        urls = self.urls()
        appkit, foundation, panels = self.fake_cocoa(urls)
        with patch("mac_permissions._cocoa", return_value=(appkit, foundation)):
            self.assertTrue(authorize_folders(self.path))
        self.assertEqual(_load_record(self.path), self.record)
        for panel, url in zip(panels, urls):
            panel.setCanChooseDirectories_.assert_called_once_with(True)
            panel.setCanChooseFiles_.assert_called_once_with(False)
            url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error_.assert_called_once_with(
                0, None, None, None)
        self.assertEqual(set(self.active), {str(folder) for folder in BOOKS_FOLDERS})
        self.assertEqual([call.args for call in foundation.NSURL.fileURLWithPath_isDirectory_.call_args_list],
                         [(str(folder), True) for folder in BOOKS_FOLDERS])

    def test_wrong_folder_is_rejected_and_picker_retries_exact_location(self):
        urls = self.urls()
        wrong = Mock()
        wrong.isFileURL.return_value = True
        wrong.path.return_value = str(Path.home())
        appkit, foundation, panels = self.fake_cocoa([wrong, *urls])
        appkit.NSAlert.alloc.return_value.init.return_value.runModal.return_value = 1000
        with patch("mac_permissions._cocoa", return_value=(appkit, foundation)):
            self.assertTrue(authorize_folders(self.path))
        wrong.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error_.assert_not_called()
        self.assertEqual(_load_record(self.path), self.record)

    def test_restore_validates_resolved_roots_before_retaining_without_ui(self):
        _save_record(self.record, self.path)
        urls = self.urls()
        appkit, foundation, panels = self.fake_cocoa(urls)
        resolver = foundation.NSURL.URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error_
        resolver.side_effect = [(url, False, None) for url in urls]
        with patch("mac_permissions._cocoa", return_value=(appkit, foundation)):
            restore_folder_access(self.path)
        for call in resolver.call_args_list:
            self.assertEqual(call.args[1], 256 | 32768)
        self.assertEqual(set(self.active), {str(folder) for folder in BOOKS_FOLDERS})
        appkit.NSApplication.sharedApplication.assert_not_called()

        self.active.clear()
        urls[1].path.return_value = str(Path.home())
        resolver.side_effect = [(url, False, None) for url in urls]
        with patch("mac_permissions._cocoa", return_value=(appkit, foundation)):
            with self.assertRaisesRegex(CompanionError, "invalid"):
                restore_folder_access(self.path)
        self.assertEqual(self.active, {})


if __name__ == "__main__":
    unittest.main()
