import plistlib
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from background import (CONFIG, BackgroundService, LABEL, LAUNCHCTL, PERMISSIONS_LABEL,
                        RUNTIME_MODULES, permissions_definition, service_definition)
from companion import CompanionError, write_config


class FakeCommands:
    def __init__(self):
        self.loaded_labels = set()
        self.calls = []

    @property
    def loaded(self):
        return LABEL in self.loaded_labels

    @loaded.setter
    def loaded(self, value):
        if value:
            self.loaded_labels.add(LABEL)
        else:
            self.loaded_labels.discard(LABEL)

    def __call__(self, arguments, **kwargs):
        self.calls.append(arguments)
        code, output = 0, ""
        if arguments[0] == LAUNCHCTL:
            if arguments[1] == "print":
                loaded = arguments[2].rsplit("/", 1)[-1] in self.loaded_labels
                code = 0 if loaded else 113
                output = "state = running\n pid = 1234\n" if loaded else ""
            elif arguments[1] == "bootstrap":
                definition = plistlib.loads(Path(arguments[3]).read_bytes())
                self.loaded_labels.add(definition["Label"])
            elif arguments[1] == "bootout":
                self.loaded_labels.discard(arguments[2].rsplit("/", 1)[-1])
        return subprocess.CompletedProcess(arguments, code, output, "")


class BackgroundServiceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "Reader Project With Spaces"
        self.home = Path(self.temp.name) / "home"
        self.runtime = self.home / "Library/Application Support/Apple Books Companion"
        self.root.mkdir()
        for module in RUNTIME_MODULES:
            (self.root / module).write_text(f"# {module}\n")
        (self.root / "private-file.txt").write_text("do not copy")
        self.config_path = self.runtime / ".local/companion.json"
        write_config({"server": "https://reader.example", "deviceId": "test-mac", "name": "Test Mac",
                      "credential": "device_" + "a" * 43, "sequence": 0, "allowLocalHttp": False}, self.config_path)
        executable = self.root / ".local/transfer-venv/bin/python"
        executable.parent.mkdir(parents=True)
        executable.write_text("#!/bin/sh\n")
        executable.chmod(0o700)
        (executable.parent / "python3").symlink_to("python")
        self.run = FakeCommands()
        self.service = BackgroundService(root=self.root, home=self.home, uid=501, run=self.run,
                                         runtime=self.runtime, config_path=self.config_path)

    def test_installs_absolute_argument_vector_without_credentials(self):
        result = self.service.install()
        self.assertEqual(result["state"], "running")
        self.assertEqual(result["pid"], 1234)
        definition = plistlib.loads(self.service.plist.read_bytes())
        self.assertEqual(definition, service_definition(self.runtime))
        self.assertEqual(definition["KeepAlive"], {"SuccessfulExit": False})
        self.assertTrue(definition["RunAtLoad"])
        self.assertEqual(definition["ProgramArguments"][-2:], ["serve", "--background"])
        self.assertEqual(definition["ProgramArguments"][0], str(self.runtime.resolve() / ".local/transfer-venv/bin/python"))
        self.assertNotIn("device_", self.service.plist.read_text())
        self.assertEqual(self.service.plist.stat().st_mode & 0o777, 0o600)
        self.assertIn([LAUNCHCTL, "bootstrap", "gui/501", str(self.service.plist)], self.run.calls)
        for module in RUNTIME_MODULES:
            self.assertEqual((self.runtime / module).read_bytes(), (self.root / module).read_bytes())
        self.assertFalse((self.runtime / "private-file.txt").exists())
        self.assertTrue((self.runtime / ".local/transfer-venv/bin/python3").is_symlink())

    def test_uninstall_is_idempotent_and_keeps_pairing(self):
        config_before = self.config_path.read_bytes()
        database = self.runtime / ".local/reader.sqlite3"
        database.write_bytes(b"saved progress")
        self.service.install()
        self.service.install()
        self.assertTrue(self.service.uninstall())
        self.assertFalse(self.service.uninstall())
        self.assertEqual(self.config_path.read_bytes(), config_before)
        self.assertEqual(database.read_bytes(), b"saved progress")
        self.assertFalse(self.service.plist.exists())
        self.assertFalse(self.run.loaded)

    def test_reinstall_stops_only_matching_service(self):
        self.service.install()
        self.run.calls.clear()
        self.service.install()
        self.assertEqual([call for call in self.run.calls if call[1] == "bootout"],
                         [[LAUNCHCTL, "bootout", f"gui/501/{LABEL}"]])

    def test_reinstall_can_reuse_installed_dependencies(self):
        self.service.install()
        shutil.rmtree(self.root / ".local/transfer-venv")
        (self.root / "companion.py").write_text("# new version\n")
        self.service.install()
        self.assertEqual((self.runtime / "companion.py").read_text(), "# new version\n")
        self.assertTrue((self.runtime / ".local/transfer-venv/bin/python").exists())

    def test_migrates_only_exact_legacy_checkout_command(self):
        self.service.plist.parent.mkdir(parents=True)
        self.service.plist.write_bytes(plistlib.dumps(service_definition(self.root)))
        self.run.loaded = True
        self.service.install()
        self.assertEqual(plistlib.loads(self.service.plist.read_bytes()), service_definition(self.runtime))
        self.assertIn([LAUNCHCTL, "bootout", f"gui/501/{LABEL}"], self.run.calls)

    def test_unrelated_or_symlink_plist_is_not_changed(self):
        self.service.plist.parent.mkdir(parents=True)
        unrelated = {"Label": LABEL, "ProgramArguments": ["/bin/sleep", "100"]}
        self.service.plist.write_bytes(plistlib.dumps(unrelated))
        for action in (self.service.install, self.service.uninstall):
            with self.assertRaisesRegex(CompanionError, "different command"):
                action()
        self.assertEqual(plistlib.loads(self.service.plist.read_bytes()), unrelated)
        self.assertFalse(any(call[0] == LAUNCHCTL for call in self.run.calls))
        self.service.plist.unlink()
        self.service.plist.symlink_to(self.config_path)
        with self.assertRaisesRegex(CompanionError, "regular file"):
            self.service.uninstall()

    def test_unpaired_install_does_not_write_or_load_agent(self):
        self.config_path.unlink()
        with self.assertRaisesRegex(CompanionError, "not paired"):
            self.service.install()
        self.assertFalse(self.service.plist.exists())
        self.assertEqual(self.run.calls, [])

    def test_default_config_migrates_before_validation(self):
        service = BackgroundService(root=self.root, home=self.home, uid=501, run=self.run,
                                    runtime=self.runtime, config_path=CONFIG)
        events = []
        with patch("background.migrate_legacy_config", side_effect=lambda: events.append("migrate")), \
                patch("background.read_config", side_effect=lambda path: events.append(("read", path))):
            service.validate_install()
        self.assertEqual(events, ["migrate", ("read", CONFIG)])

    def test_authorize_stages_runtime_preserves_state_and_starts_only_the_picker_job(self):
        self.service.install()
        config_before = self.config_path.read_bytes()
        database = self.runtime / ".local/reader.sqlite3"
        database.write_bytes(b"saved progress")
        self.run.calls.clear()
        self.service.authorize()
        self.assertEqual(self.run.loaded_labels, {PERMISSIONS_LABEL})
        self.assertEqual(self.config_path.read_bytes(), config_before)
        self.assertEqual(database.read_bytes(), b"saved progress")
        self.assertEqual(self.service.permissions_plist.parent, self.runtime.resolve() / ".local")
        self.assertEqual(self.service.permissions_plist.stat().st_mode & 0o777, 0o600)
        setup = plistlib.loads(self.service.permissions_plist.read_bytes())
        self.assertEqual(setup, permissions_definition(self.runtime))
        self.assertEqual(setup["ProgramArguments"], [str(self.runtime.resolve() / ".local/transfer-venv/bin/python"),
                                                    str(self.runtime.resolve() / "background.py"), "grant-folders"])
        self.assertEqual(setup["ProcessType"], "Interactive")
        self.assertIs(setup["KeepAlive"], False)
        self.assertTrue(setup["RunAtLoad"])
        self.assertEqual(plistlib.loads(self.service.plist.read_bytes()), service_definition(self.runtime))
        self.assertEqual([call for call in self.run.calls if call[:2] == [LAUNCHCTL, "bootstrap"]],
                         [[LAUNCHCTL, "bootstrap", "gui/501", str(self.service.permissions_plist)]])
        self.assertIn([LAUNCHCTL, "bootout", self.service.target], self.run.calls)
        dependency_checks = [call[2] for call in self.run.calls if call[0] != LAUNCHCTL]
        self.assertTrue(any("AppKit" in check and 'objc.__version__ == "13.0"' in check for check in dependency_checks))

    def test_successful_folder_grant_starts_the_normal_agent_on_the_main_thread(self):
        self.service.authorize()
        self.run.calls.clear()
        threads = []
        picker = Mock(side_effect=lambda: threads.append(threading.current_thread()) or True)
        with patch.dict("sys.modules", {"mac_permissions": SimpleNamespace(authorize_folders=picker)}), patch("builtins.print"):
            self.assertTrue(self.service.grant_folders())
        picker.assert_called_once_with()
        self.assertEqual(threads, [threading.main_thread()])
        self.assertTrue(self.run.loaded)
        self.assertEqual([call for call in self.run.calls if call[:2] == [LAUNCHCTL, "bootstrap"]],
                         [[LAUNCHCTL, "bootstrap", "gui/501", str(self.service.plist)]])

    def test_cancelled_folder_grant_leaves_the_main_agent_stopped(self):
        self.service.authorize()
        self.run.calls.clear()
        picker = Mock(return_value=False)
        with patch.dict("sys.modules", {"mac_permissions": SimpleNamespace(authorize_folders=picker)}), patch("builtins.print"):
            self.assertFalse(self.service.grant_folders())
        picker.assert_called_once_with()
        self.assertFalse(self.run.loaded)
        self.assertFalse(any(call[:2] == [LAUNCHCTL, "bootstrap"] for call in self.run.calls))

    def test_unrelated_setup_job_or_unowned_plist_is_left_untouched(self):
        self.service.install()
        unrelated = dict(permissions_definition(self.runtime), ProgramArguments=["/bin/sleep", "100"])
        self.service.write_definition(self.service.permissions_plist, unrelated)
        self.run.loaded_labels.add(PERMISSIONS_LABEL)
        original = self.service.permissions_plist.read_bytes()
        self.run.calls.clear()
        for action in (self.service.authorize, self.service.uninstall):
            with self.assertRaisesRegex(CompanionError, "different command"):
                action()
        self.assertEqual(self.service.permissions_plist.read_bytes(), original)
        self.assertTrue(self.run.loaded)
        self.assertEqual(self.run.calls, [])
        self.service.write_definition(self.service.permissions_plist, permissions_definition(self.runtime))
        self.service.permissions_plist.chmod(0o644)
        with self.assertRaisesRegex(CompanionError, "0600"):
            self.service.authorize()
        self.service.permissions_plist.unlink()
        self.service.permissions_plist.symlink_to(self.config_path)
        with self.assertRaisesRegex(CompanionError, "regular file"):
            self.service.authorize()
        self.assertTrue(self.run.loaded)
        self.assertEqual(self.run.calls, [])

    def test_uninstall_stops_pending_picker_and_keeps_pairing_and_folder_bookmarks(self):
        self.service.authorize()
        config_before = self.config_path.read_bytes()
        bookmarks = self.runtime / ".local/folder-access.json"
        bookmarks.write_bytes(b"saved folder bookmarks")
        self.run.calls.clear()
        self.assertTrue(self.service.uninstall())
        self.assertEqual(self.run.loaded_labels, set())
        self.assertFalse(self.service.plist.exists())
        self.assertFalse(self.service.permissions_plist.exists())
        self.assertEqual(self.config_path.read_bytes(), config_before)
        self.assertEqual(bookmarks.read_bytes(), b"saved folder bookmarks")
        self.assertIn([LAUNCHCTL, "bootout", self.service.permissions_target], self.run.calls)
        self.assertFalse(self.service.uninstall())

    def test_grant_cannot_restart_after_installation_is_removed_during_picker(self):
        self.service.authorize()
        def choose_after_uninstall():
            self.service.uninstall()
            return True
        picker = Mock(side_effect=choose_after_uninstall)
        self.run.calls.clear()
        with patch.dict("sys.modules", {"mac_permissions": SimpleNamespace(authorize_folders=picker)}):
            with self.assertRaisesRegex(CompanionError, "Install the current companion"):
                self.service.grant_folders()
        self.assertFalse(self.run.loaded)
        self.assertFalse(any(call[:2] == [LAUNCHCTL, "bootstrap"] for call in self.run.calls))


if __name__ == "__main__":
    unittest.main()
