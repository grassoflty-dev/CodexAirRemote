"""Back up, flash, verify and provision exactly one Waveshare ESP32-S3."""

import argparse
from datetime import datetime
import hashlib
import json
import msvcrt
import os
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
from getpass import getpass

import serial
from serial.tools import list_ports

import hotspot
from app_runtime import APP, FROZEN, LOCAL, ROOT, launch_service, set_preferences, write_json

IMAGES = ROOT / "firmware" / "build"
FLASH_BYTES = 16 * 1024 * 1024
USB_ID = (0x303A, 0x1001)


def select_port(explicit=None):
    candidates = [item for item in list_ports.comports() if (item.vid, item.pid) == USB_ID]
    if explicit:
        candidates = [item for item in candidates if item.device.casefold() == explicit.casefold()]
    if not candidates:
        raise RuntimeError("未找到 Espressif USB 设备。请用支持数据传输的 USB-C 线连接开发板。")
    if len(candidates) != 1:
        choices = ", ".join(item.device for item in candidates)
        raise RuntimeError(f"检测到多个 Espressif 设备（{choices}）。请只连接要烧录的开发板。")
    return candidates[0].device


def image_args():
    manifest = json.loads((IMAGES / "airremote-release.json").read_text(encoding="utf-8"))
    expected = {
        "0x0": "bootloader/bootloader.bin",
        "0x8000": "partition_table/partition-table.bin",
        "0x10d000": "ota_data_initial.bin",
        "0x200000": "codex_air_remote.bin",
    }
    if set(manifest) != set(expected):
        raise RuntimeError("Unexpected image layout")
    args = ["--flash-mode", "dio", "--flash-size", "16MB", "--flash-freq", "80m"]
    for address, name in expected.items():
        path = IMAGES / name
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if manifest[address] != {"path": name, "sha256": digest}:
            raise RuntimeError(f"Integrity check failed for {name}")
        args.extend((address, str(path)))
    return args


def esptool(port, *args, timeout=450, log=print):
    arguments = ["--chip", "esp32s3", "--port", port, "--baud", "921600", *args]
    with TemporaryDirectory(prefix="airremote-esptool-") as scratch:
        output_path = Path(scratch) / "output.txt"
        try:
            if FROZEN:
                result = subprocess.run(
                    [sys.executable, "--esptool-worker", str(output_path), *arguments],
                    creationflags=subprocess.CREATE_NO_WINDOW, timeout=timeout,
                )
            else:
                with output_path.open("wb") as output:
                    result = subprocess.run(
                        [sys.executable, "-m", "esptool", *arguments], stdout=output,
                        stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW, timeout=timeout,
                    )
        finally:
            text = output_path.read_text(encoding="utf-8", errors="replace") if output_path.is_file() else ""
            if text:
                log(text.rstrip())
    if result.returncode:
        raise RuntimeError(f"烧录工具执行 {args[0]} 失败（{result.returncode}）。详情见烧录日志。")
    return text


def board_identity(port, log):
    output = esptool(port, "flash-id", timeout=35, log=log)
    if not re.search(r"Detected flash size:\s*16\s*MB\b", output, re.I):
        raise RuntimeError("检测到的 Flash 不是 16 MB，请确认开发板型号。")
    identity = re.search(r"\bMAC:\s*([0-9a-f:]{17})\b", output, re.I)
    if not identity:
        raise RuntimeError("无法读取 ESP32-S3 的设备标识。")
    return identity.group(1).replace(":", "").lower()


def ensure_backup(port, identity, progress, log):
    folder = LOCAL / "backups"
    folder.mkdir(exist_ok=True)
    image = folder / f"{identity}-before-air-remote.bin"
    checksum = image.with_suffix(".sha256")
    if image.is_file():
        if image.stat().st_size != FLASH_BYTES:
            raise RuntimeError("原始备份大小异常，已停止烧录。")
        digest = hashlib.sha256(image.read_bytes()).hexdigest()
        if checksum.is_file() and checksum.read_text(encoding="ascii").strip() != digest:
            raise RuntimeError("原始备份校验不一致，已停止烧录。")
    else:
        temp = image.with_suffix(".partial")
        if temp.exists():
            temp = image.with_name(f"{image.stem}-{time.time_ns()}.partial")
        progress("正在备份原厂 Flash，可能需要几分钟……")
        esptool(port, "read-flash", "0x0", hex(FLASH_BYTES), str(temp), log=log)
        if temp.stat().st_size != FLASH_BYTES:
            raise RuntimeError("Flash backup has an unexpected size")
        digest = hashlib.sha256(temp.read_bytes()).hexdigest()
        temp.rename(image)
    checksum.write_text(digest + "\n", encoding="ascii")
    log(f"Original flash backup verified: {image}")


def serial_reply(link, command, prefix, deadline, retry=False):
    next_send = 0
    while time.monotonic() < deadline:
        if time.monotonic() >= next_send:
            link.write(command)
            next_send = time.monotonic() + 1 if retry else float("inf")
        reply = link.readline().strip()
        if reply.startswith(prefix):
            return reply
    raise RuntimeError("The device did not respond over USB")


def validate_wifi(ssid, password):
    ssid = ssid.encode("utf-8")
    password = password.encode("utf-8")
    if not 1 <= len(ssid) <= 32 or not 8 <= len(password) <= 63:
        raise ValueError("请填写 1–32 字节的 Wi-Fi 名称和 8–63 字节的 WPA2 密码。")
    return ssid, password


def provision(port, ssid, password):
    ssid, password = validate_wifi(ssid, password)
    expiry = time.monotonic() + 25
    link = serial.Serial(baudrate=115200, timeout=0.35, write_timeout=1)
    link.dtr = link.rts = False
    link.port = port
    while True:
        try:
            link.open()
            break
        except serial.SerialException:
            if time.monotonic() >= expiry:
                raise
            time.sleep(0.5)
    with link:
        ready = serial_reply(link, b"\nAR1?\n", b"AR1 READY ", time.monotonic() + 30, retry=True)
        board = re.fullmatch(rb"AR1 READY 7 ([0-9a-f]{12})", ready)
        if not board:
            raise RuntimeError(f"The board reported a hardware initialization error ({ready.decode('ascii')}).")
        command = f"AR1W {ssid.hex()} {password.hex()}\n".encode("ascii")
        reply = serial_reply(link, command, b"AR1 WIFI ", time.monotonic() + 5)
        if reply != b"AR1 WIFI OK":
            raise RuntimeError("The board could not store Wi-Fi settings")
    return board.group(1).decode("ascii")


def launch_companion():
    if not APP.is_file():
        raise RuntimeError("Codex Air Remote Windows app is missing")
    env = dict(os.environ, AIRREMOTE_COMPANION=str(APP))
    command = (
        "$ws=New-Object -ComObject WScript.Shell; "
        "$lnk=$ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Air Remote.lnk')); "
        "$lnk.TargetPath=$env:AIRREMOTE_COMPANION; $lnk.Arguments='--service'; "
        "$lnk.WorkingDirectory=Split-Path $env:AIRREMOTE_COMPANION; $lnk.Save()"
    )
    subprocess.run(["powershell.exe", "-NoProfile", "-Command", command], env=env, check=True,
                   creationflags=subprocess.CREATE_NO_WINDOW, timeout=15)
    set_preferences(True)
    launch_service()


def pair_mouse(address):
    command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
               str(Path(__file__).with_name("pair-mouse.ps1")), "-Address", address]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=50,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        status = result.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        status = ""
    return status in {"Paired", "AlreadyPaired"}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", help="Specific Espressif COM port")
    parser.add_argument("--wifi-ssid", help="Use an existing 2.4 GHz WPA2 network instead of the Windows hotspot")
    parser.add_argument("--check", action="store_true", help="Verify the compiled files and Windows hotspot without writing to a board")
    parser.add_argument("--provision-only", action="store_true", help="Set Wi-Fi again after a successful flash")
    return parser.parse_args()


def run_setup(*, port=None, wifi=None, provision_only=False, report=print):
    """Set up one board, with either automatic hotspot or a supplied Wi-Fi pair."""
    LOCAL.mkdir(parents=True, exist_ok=True)
    with (LOCAL / "flash.lock").open("a+b") as lock:
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            raise RuntimeError("已有另一个烧录或配网任务在运行。") from exc
        with (LOCAL / "setup.log").open("a", encoding="utf-8") as history:
            def log(message):
                history.write(f"{datetime.now():%Y-%m-%d %H:%M:%S} {message}\n")
                history.flush()

            def progress(message):
                log(message)
                report(message)

            try:
                return setup_board(port, wifi, provision_only, progress, log)
            except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
                log(f"Setup failed: {exc}")
                raise


def setup_board(port, wifi, provision_only, progress, log):
    progress("正在检查 USB 开发板和烧录文件……")
    port = select_port(port)
    if not APP.is_file():
        raise RuntimeError("找不到 Windows 辅助程序。")
    images = () if provision_only else image_args()
    started_hotspot = False
    configured = False
    written = False
    try:
        if wifi is not None:
            mode = "lan"
            ssid, password = wifi
            validate_wifi(ssid, password)
        else:
            mode = "hotspot"
            ssid, password = hotspot.identity()
            progress("正在准备 Windows 2.4 GHz 热点……")
            response = hotspot.operate("Start")
            started_hotspot = response == "Success"
            if not started_hotspot and not hotspot.selected():
                raise RuntimeError("已有 Windows 热点在运行。首次使用此模式前，请先关闭现有热点。")

        if not provision_only:
            progress(f"正在识别开发板（{port}）……")
            identity = board_identity(port, log)
            ensure_backup(port, identity, progress, log)
            if board_identity(port, log) != identity:
                raise RuntimeError("备份后 USB 设备发生变化，已停止烧录。")
            progress("正在写入并校验固件，请保持 USB 连接……")
            esptool(port, "write-flash", *images, log=log)
            written = True
        progress("正在通过 USB 写入 Wi-Fi 配置……")
        try:
            ble_address = provision(port, ssid, password)
        except (OSError, RuntimeError, ValueError) as exc:
            if written:
                raise RuntimeError(f"固件已烧录，配网失败。可以重试「只重新配网」。{exc}") from exc
            raise
        write_json(hotspot.STATE, {"mode": mode})
        configured = True
        try:
            launch_companion()
        except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
            raise RuntimeError(f"配网已完成，但辅助服务启动失败。{exc}") from exc
        progress("正在尝试配对蓝牙鼠标，请留意 Windows 配对提示……")
        return pair_mouse(ble_address)
    finally:
        if started_hotspot and not configured:
            try:
                hotspot.operate("Stop")
            except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
                log(f"Could not stop the setup hotspot: {exc}")


def main():
    args = parse_args()
    if args.check:
        image_args()
        print("All four firmware files match the release manifest.")
        status = json.loads(hotspot.operate("Inspect"))
        print(f"Windows hotspot: {status['capability']}; 2.4 GHz: {status['band24']}; current state: {status['state']}.")
        return
    wifi = (args.wifi_ssid, getpass("2.4 GHz Wi-Fi password: ")) if args.wifi_ssid else None
    paired = run_setup(port=args.port, wifi=wifi, provision_only=args.provision_only)
    print("配网完成，蓝牙鼠标已配对。" if paired else "配网完成。请在 Windows 蓝牙设置中添加 Codex Air Remote。")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
        print(f"Air Remote setup: {exc}", file=sys.stderr)
        sys.exit(1)
