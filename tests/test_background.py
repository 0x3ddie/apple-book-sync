import plistlib
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from background import CONFIG, BackgroundService, LABEL, LAUNCHCTL, RUNTIME_MODULES, service_definition
from companion import CompanionError, write_config


class FakeCommands:
    def __init__(self):
        self.loaded = False
        self.calls = []

    def __call__(self, arguments, **kwargs):
        self.calls.append(arguments)
        code, output = 0, ""
        if arguments[0] == LAUNCHCTL:
            if arguments[1] == "print":
                code = 0 if self.loaded else 113
                output = "state = running\n pid = 1234\n" if self.loaded else ""
            elif arguments[1] == "bootstrap":
                self.loaded = True
            elif arguments[1] == "bootout":
                self.loaded = False
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


if __name__ == "__main__":
    unittest.main()
