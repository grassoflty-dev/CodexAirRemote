"""Per-session 2.4 GHz access point using Windows' built-in hotspot."""

import hashlib
import hmac
import json
from pathlib import Path
import subprocess

from codex_adapter import LOCAL

SCRIPT = Path(__file__).with_name("hotspot.ps1")
STATE = LOCAL / "network.json"


def identity():
    key = bytes.fromhex((LOCAL / "pairing.txt").read_text(encoding="ascii").strip())
    suffix = hashlib.sha256(key).hexdigest()[:6].upper()
    password = hmac.new(key, b"Air Remote Wi-Fi", hashlib.sha256).hexdigest()[:24]
    return f"AirRemote-{suffix}", password


def operate(action):
    params = None
    if action == "Start":
        ssid, password = identity()
        params = json.dumps({"ssid": ssid, "password": password})
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
         "-File", str(SCRIPT), "-Operation", action],
        input=params or "", capture_output=True, text=True, timeout=40,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    if result.returncode:
        lines = [line.strip() for line in result.stderr.splitlines() if line.strip()]
        raise RuntimeError(lines[0] if lines else "Windows hotspot failed")
    return result.stdout.strip()


def selected():
    return STATE.is_file() and json.loads(STATE.read_text(encoding="utf-8")).get("mode") == "hotspot"
