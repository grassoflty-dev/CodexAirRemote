"""Shared paths, settings, and local service state for the Windows app."""

import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

FROZEN = getattr(sys, "frozen", False)
ROOT = (Path(sys.executable) if FROZEN else Path(__file__)).resolve().parents[1]
LOCAL = Path(os.environ.get("AIRREMOTE_DATA_DIR", ROOT / ".local"))
APP = ROOT / "app" / "CodexAirRemote.exe"
PREFERENCES = LOCAL / "companion-settings.json"
STATE = LOCAL / "companion-state.json"
MUTEX_NAME = r"Local\CodexAirRemoteCompanion"

kernel = ctypes.WinDLL("kernel32", use_last_error=True)
kernel.CreateMutexW.argtypes = (ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR)
kernel.CreateMutexW.restype = wintypes.HANDLE
kernel.OpenMutexW.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR)
kernel.OpenMutexW.restype = wintypes.HANDLE
kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
kernel.CloseHandle.restype = wintypes.BOOL


def claim_service():
    handle = kernel.CreateMutexW(None, False, MUTEX_NAME)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:
        kernel.CloseHandle(handle)
        return None
    return handle


def service_running():
    handle = kernel.OpenMutexW(0x100000, False, MUTEX_NAME)  # SYNCHRONIZE
    if handle:
        kernel.CloseHandle(handle)
    return bool(handle)


def read_json(path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                     prefix=path.stem + "-", suffix=".tmp", delete=False) as file:
        pending = Path(file.name)
        json.dump(value, file, ensure_ascii=False)
    try:
        for attempt in range(5):
            try:
                pending.replace(path)
                return
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(0.025)
    finally:
        pending.unlink(missing_ok=True)


def preferences():
    return read_json(PREFERENCES).get("enabled") is not False


def set_preferences(enabled):
    write_json(PREFERENCES, {"enabled": bool(enabled)})


def provisioned():
    return read_json(LOCAL / "network.json").get("mode") in {"lan", "hotspot"}


def launch_service():
    if FROZEN:
        command = [sys.executable, "--service"]
    else:
        pythonw = Path(sys.executable).with_name("pythonw.exe")
        command = [str(pythonw), str(ROOT / "host" / "companion.py")]
    return subprocess.Popen(
        command, cwd=ROOT, close_fds=True, stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
    )


class ServiceStatus:
    def __init__(self):
        self.data = {"pid": os.getpid(), "phase": "loading", "last": ""}
        self.last_write = 0

    def update(self, phase, **values):
        self.data.update(phase=phase, **values)
        self.flush(force=True)

    def flush(self, force=False):
        now = time.time()
        if force or now - self.last_write >= 2:
            write_json(STATE, {**self.data, "updated": now})
            self.last_write = now
