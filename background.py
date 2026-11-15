"""Install or remove the paired Mac companion as a per-user login service."""

import argparse
import os
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

from companion import CONFIG, RUNTIME, CompanionError, migrate_legacy_config, read_config


LABEL = "xyz.eddiechen.books-companion"
PERMISSIONS_LABEL = f"{LABEL}.permissions"
ROOT = Path(__file__).resolve().parent
LAUNCHCTL = "/bin/launchctl"
RUNTIME_MODULES = ("companion.py", "transfer.py", "library.py", "prepare.py", "background.py", "mac_permissions.py", "covers.py", "progress.py", "position_sync.py")


def service_definition(root):
    root = Path(root).resolve()
    log = str(root / ".local/companion-background.log")
    return {
        "Label": LABEL,
        "ProgramArguments": [str(root / ".local/transfer-venv/bin/python"),
                             str(root / "companion.py"), "serve", "--background"],
        "WorkingDirectory": str(root),
        "RunAtLoad": True,
        # Revocation is an intentional clean exit; do not keep restarting it.
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 60,
        "ProcessType": "Background",
        "EnvironmentVariables": {"PYTHONUNBUFFERED": "1"},
        "StandardOutPath": log,
        "StandardErrorPath": log,
    }


def permissions_definition(root):
    root = Path(root).resolve()
    log = str(root / ".local/companion-background.log")
    return {
        "Label": PERMISSIONS_LABEL,
        "ProgramArguments": [str(root / ".local/transfer-venv/bin/python"),
                             str(root / "background.py"), "grant-folders"],
        "WorkingDirectory": str(root),
        "RunAtLoad": True,
        "KeepAlive": False,
        "ProcessType": "Interactive",
        "EnvironmentVariables": {"PYTHONUNBUFFERED": "1"},
        "StandardOutPath": log,
        "StandardErrorPath": log,
    }


class BackgroundService:
    def __init__(self, root=ROOT, home=None, uid=None, run=subprocess.run, runtime=RUNTIME, config_path=CONFIG):
        self.root = Path(root).resolve()
        runtime = Path(runtime)
        self.runtime = runtime.parent.resolve() / runtime.name
        self.config_path = Path(config_path)
        self.plist = Path(home or Path.home()) / "Library/LaunchAgents" / f"{LABEL}.plist"
        self.uid = os.getuid() if uid is None else uid
        self.domain = f"gui/{self.uid}"
        self.target = f"{self.domain}/{LABEL}"
        self.permissions_target = f"{self.domain}/{PERMISSIONS_LABEL}"
        # A one-shot picker must never open automatically at login.
        self.permissions_plist = self.runtime / ".local" / f"{PERMISSIONS_LABEL}.plist"
        self.run = run

    def command(self, *arguments, required=True):
        result = self.run([LAUNCHCTL, *arguments], capture_output=True, text=True, timeout=15)
        if required and result.returncode:
            raise CompanionError(f"launchctl {arguments[0]} failed (exit {result.returncode}). "
                                 "Run this command as your normal Mac user while logged in to the desktop.")
        return result

    def installed_definition(self):
        try:
            info = self.plist.lstat()
        except FileNotFoundError:
            return None
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise CompanionError("The companion LaunchAgent must be a regular file owned by this Mac user.")
        try:
            definition = plistlib.loads(self.plist.read_bytes())
        except (ValueError, plistlib.InvalidFileException):
            raise CompanionError("The existing companion LaunchAgent is invalid; it was left unchanged.") from None
        # Accept the original checkout-based agent only to migrate that known command.
        expected = (service_definition(self.runtime), service_definition(self.root))
        if (not isinstance(definition, dict) or not any(
                definition.get("Label") == LABEL
                and definition.get("ProgramArguments") == candidate["ProgramArguments"]
                and definition.get("WorkingDirectory") == candidate["WorkingDirectory"]
                for candidate in expected)):
            raise CompanionError("An existing LaunchAgent with this name belongs to a different command or checkout. "
                                 "It was left unchanged.")
        return definition

    def installed_permissions_definition(self):
        try:
            info = self.permissions_plist.lstat()
        except FileNotFoundError:
            return None
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise CompanionError("The folder-access setup plist must be an owned regular file with permissions 0600.")
        try:
            definition = plistlib.loads(self.permissions_plist.read_bytes())
        except (ValueError, plistlib.InvalidFileException):
            raise CompanionError("The existing folder-access setup plist is invalid; it was left unchanged.") from None
        if definition != permissions_definition(self.runtime):
            raise CompanionError("The existing folder-access setup plist belongs to a different command. It was left unchanged.")
        return definition

    def validate_install(self):
        if self.config_path == CONFIG:
            migrate_legacy_config()
        read_config(self.config_path)
        for module in RUNTIME_MODULES:
            if not (self.root / module).is_file():
                raise CompanionError(f"The source checkout is missing {module}; download the complete companion first.")
        for directory in (self.root, self.runtime):
            environment = directory / ".local/transfer-venv"
            executable = environment / "bin/python"
            if not executable.is_file() or not os.access(executable, os.X_OK):
                continue
            result = self.run([str(executable), "-c",
                               'import aiortc, AppKit, objc; assert aiortc.__version__ == "1.16.0"; assert objc.__version__ == "13.0"'],
                              capture_output=True, text=True, timeout=20)
            if not result.returncode:
                return environment
        raise CompanionError("Companion dependencies are missing or outdated. Run ./scripts/start-transfers.sh first.")

    @staticmethod
    def private_directory(path):
        path.mkdir(parents=True, exist_ok=True)
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise CompanionError("The companion runtime must be a directory owned by this Mac user, not a symlink.")
        path.chmod(0o700)

    def copy_runtime(self, environment):
        self.private_directory(self.runtime)
        self.private_directory(self.runtime / ".local")
        destination = self.runtime / ".local/transfer-venv"
        if environment != destination:
            # Stage the complete environment before replacing only that dependency directory.
            # Pairing, cached EPUBs, and reader databases under .local remain untouched.
            with tempfile.TemporaryDirectory(prefix=".transfer-install-", dir=self.runtime / ".local") as temporary:
                staged = Path(temporary) / "transfer-venv"
                shutil.copytree(environment, staged, symlinks=True)
                if destination.is_symlink():
                    raise CompanionError("The installed dependency directory must not be a symlink.")
                if destination.exists():
                    shutil.rmtree(destination)
                os.replace(staged, destination)
        for module in RUNTIME_MODULES:
            descriptor, temporary = tempfile.mkstemp(prefix=f".{module}-", dir=self.runtime)
            try:
                with os.fdopen(descriptor, "wb") as output:
                    output.write((self.root / module).read_bytes())
                os.replace(temporary, self.runtime / module)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)

    @staticmethod
    def write_definition(path, definition):
        descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
        try:
            with os.fdopen(descriptor, "wb") as output:
                plistlib.dump(definition, output)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def install(self, *, start=True):
        environment = self.validate_install()
        previous = self.installed_definition()
        loaded = self.command("print", self.target, required=False).returncode == 0
        if loaded and previous is None:
            raise CompanionError("A service with this name is already loaded without this checkout's LaunchAgent. "
                                 "It was left unchanged.")
        if loaded:
            self.command("bootout", self.target)
        self.copy_runtime(environment)
        self.plist.parent.mkdir(parents=True, exist_ok=True)
        log = self.runtime / ".local/companion-background.log"
        descriptor = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                raise CompanionError("The companion log must be a regular file owned by this Mac user.")
            os.fchmod(descriptor, 0o600)
        finally:
            os.close(descriptor)
        self.write_definition(self.plist, service_definition(self.runtime))
        if start:
            self.start_installed()
        return self.status()

    def start_installed(self):
        if self.installed_definition() != service_definition(self.runtime):
            raise CompanionError("Install the current companion before starting it.")
        self.command("enable", self.target)
        self.command("bootstrap", self.domain, str(self.plist))

    def authorize(self):
        previous = self.installed_permissions_definition()
        loaded = self.command("print", self.permissions_target, required=False).returncode == 0
        if loaded and previous is None:
            raise CompanionError("A folder-access setup service is loaded without its owned plist. It was left unchanged.")
        if loaded:
            self.command("bootout", self.permissions_target)
        # Stage everything while the normal sender is stopped. Its first Books read
        # happens only after the launchd-owned picker process grants folder access.
        self.install(start=False)
        self.write_definition(self.permissions_plist, permissions_definition(self.runtime))
        self.command("enable", self.permissions_target)
        self.command("bootstrap", self.domain, str(self.permissions_plist))

    def grant_folders(self):
        if self.installed_permissions_definition() is None:
            raise CompanionError("Run background.py authorize to prepare folder access first.")
        if self.installed_definition() != service_definition(self.runtime):
            raise CompanionError("The companion installation changed. Run background.py authorize again.")
        # This import and native picker run on this launchd process's main thread.
        from mac_permissions import authorize_folders
        if not authorize_folders():
            print("Folder access setup cancelled. The background companion remains stopped.", flush=True)
            return False
        self.start_installed()
        print("Folder access saved. The background companion has started.", flush=True)
        return True

    def status(self):
        installed = self.installed_definition() is not None
        result = self.command("print", self.target, required=False)
        info = {"installed": installed, "loaded": result.returncode == 0, "state": None, "pid": None}
        if info["loaded"]:
            state = re.search(r"^\s*state = ([^\n]+)", result.stdout, re.MULTILINE)
            pid = re.search(r"^\s*pid = (\d+)\s*$", result.stdout, re.MULTILINE)
            info.update(state=state.group(1).strip() if state else "loaded", pid=int(pid.group(1)) if pid else None)
        return info

    def uninstall(self):
        main = self.installed_definition()
        permissions = self.installed_permissions_definition()
        loaded = self.command("print", self.target, required=False).returncode == 0
        setup_loaded = self.command("print", self.permissions_target, required=False).returncode == 0
        if loaded and main is None or setup_loaded and permissions is None:
            raise CompanionError("A companion service is loaded without its owned plist; it was left unchanged.")
        # Stop an open picker before removing the main agent so a later selection
        # cannot restart the companion after the user has uninstalled it.
        if setup_loaded:
            self.command("bootout", self.permissions_target)
        if loaded:
            self.command("bootout", self.target)
        if permissions is not None:
            self.permissions_plist.unlink()
        if main is not None:
            self.plist.unlink()
        return main is not None or permissions is not None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("install", "status", "uninstall", "authorize", "grant-folders"))
    arguments = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("The background companion uses macOS LaunchAgents.")
    if os.getuid() == 0:
        parser.error("Run this as your normal Mac user, without sudo.")
    service = BackgroundService()
    try:
        if arguments.command == "authorize":
            service.authorize()
            print("Choose the requested Apple Books folders in the Mac dialogs. The companion starts after both are approved.")
            return 0
        if arguments.command == "grant-folders":
            return 0 if service.grant_folders() else 1
        if arguments.command == "uninstall":
            removed = service.uninstall()
            print("Background companion stopped and removed." if removed else "Background companion is not installed.")
            print("Your Mac pairing and saved books were kept.")
            return 0
        result = service.install() if arguments.command == "install" else service.status()
        if result["loaded"]:
            print(f"Background companion: {result['state']}" + (f" (PID {result['pid']})" if result["pid"] else ""))
        else:
            print("Background companion: installed but not loaded." if result["installed"] else "Background companion: not installed.")
        if result["installed"]:
            print(f"Starts when you log into this Mac. Log: {service.runtime / '.local/companion-background.log'}")
        return 0
    except (CompanionError, OSError, subprocess.SubprocessError) as error:
        print(f"Background companion: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
