"""Route authenticated board audio to Codex desktop dictation."""

import argparse
import asyncio
import ipaddress
import logging
from logging.handlers import RotatingFileHandler
import secrets
import socket
import ssl
import struct

from websockets.asyncio.client import connect

from app_runtime import LOCAL, ServiceStatus, claim_service, kernel, preferences, provisioned
from codex_adapter import Codex
from dictation import control
from virtual_mic import CablePlayback, CableSetupError, cable_device
import hotspot

DISCOVERY_PORT = 47682
VOICE_PORT = 47683
MAX_PCM_BYTES = 60 * 16000 * 2
DISCOVERY_PREFIX = b"AR1?"


def discover():
    nonce = secrets.token_bytes(16)
    broadcast = "192.168.137.255" if hotspot.selected() else "255.255.255.255"
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        udp.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        udp.settimeout(0.6)
        udp.sendto(DISCOVERY_PREFIX + nonce, (broadcast, DISCOVERY_PORT))
        while True:
            try:
                reply, peer = udp.recvfrom(64)
            except TimeoutError:
                return None
            source = ipaddress.IPv4Address(peer[0])
            if peer[1] == DISCOVERY_PORT and source.is_private and reply == b"AR1!" + nonce:
                return peer[0]


async def stream_audio(ws, playback):
    sequence = 0
    total = 0
    while True:
        await ws.send("PULL")
        frame = await asyncio.wait_for(ws.recv(), 5)
        if isinstance(frame, str) and frame in {"STOP", "SEND", "DRAFT", "CANCEL"}:
            return frame, total
        if frame == "WAIT":
            await asyncio.sleep(0.02)
            continue
        if not isinstance(frame, bytes) or not 644 <= len(frame) <= 3204 or (len(frame) - 4) % 640:
            raise ValueError("Invalid audio frame")
        if struct.unpack_from("!I", frame)[0] != sequence:
            raise ValueError("Unexpected audio sequence number")
        sequence += 1
        total += len(frame) - 4
        if total > MAX_PCM_BYTES:
            raise ValueError("Recording is too long")
        if playback is not None:
            await playback.write(frame[4:])


async def route_audio(ws, modern, report):
    playback = None
    session = None
    status = "FAILED"
    try:
        try:
            playback = CablePlayback(cable_device())
            session = await control("Start")
        except CableSetupError as exc:
            status = str(exc)
        except (OSError, RuntimeError, TimeoutError, ValueError) as exc:
            logging.warning("Could not start desktop dictation: %s", exc)
            status = "DICTATION_UNAVAILABLE"
        if modern:
            if session is None:
                return "ABORT", status
            await ws.send("CAPTURE")
            if await asyncio.wait_for(ws.recv(), 5) != "GO":
                raise ValueError("The board did not confirm microphone startup")
        action, size = await asyncio.wait_for(stream_audio(ws, playback if session else None), 80)
        if session is None:
            return "FAILED", status
        logging.info("Routed %.2f seconds of audio to the virtual microphone", size / 32000)
        if action == "CANCEL" or size < 6400:
            cancelled_playback, playback = playback, None
            cancelled_playback.close()
            await control("Cancel", session)
            session = None
            status = "CANCELLED" if action == "CANCEL" else "EMPTY"
            return ("CANCELLED" if modern and action == "CANCEL" else "EMPTY"), status
        if report:
            report.update("finishing")
        await playback.drain()
        # A lost reply after invoking Send leaves its outcome unknown. Never invoke it again.
        command = "Draft" if action == "DRAFT" else "Send"
        await control(command, session)
        session = None
        if command == "Draft":
            return "DRAFTED", "DRAFTED"
        return ("SUBMITTED" if modern else "SENT"), "SUBMITTED"
    finally:
        try:
            if playback is not None:
                playback.close()
        finally:
            if session is not None:
                try:
                    await control("Cancel", session)
                except (OSError, RuntimeError, TimeoutError, ValueError):
                    logging.warning("The Codex recording could not be cancelled automatically")


async def voice_session(address, context, pairing, report=None):
    async with connect(
        f"wss://{address}:{VOICE_PORT}/voice", ssl=context, server_hostname="airremote.local",
        proxy=None, open_timeout=4, close_timeout=1, ping_interval=None, max_size=4096,
        compression=None,
    ) as ws:
        await ws.send("AUTH " + pairing)
        handshake = await asyncio.wait_for(ws.recv(), 5)
        if handshake not in {"READY", "READY2"}:
            raise ValueError("Device refused voice pairing")
        modern = handshake == "READY2"
        if report:
            report.update("receiving")
        try:
            reply, status = await route_audio(ws, modern, report)
        except (OSError, RuntimeError, TimeoutError, ValueError) as exc:
            logging.warning("Desktop dictation ended: %s", exc)
            reply, status = ("ABORT" if modern else "FAILED"), "DICTATION_UNCONFIRMED"
        await ws.send(reply)
        if await asyncio.wait_for(ws.recv(), 5) != "ACK":
            raise RuntimeError("Device did not acknowledge the status")
        if report:
            report.update("listening", last=status)


async def serve(report):
    context = ssl.create_default_context(cafile=str(LOCAL / "server.crt"))
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    pairing = (LOCAL / "pairing.txt").read_text(encoding="ascii").strip()
    maintain_at = 0
    while True:
        enabled = preferences()
        if not enabled:
            return

        if report.data["phase"] in {"loading", "stopping"}:
            report.update("listening")

        now = asyncio.get_running_loop().time()
        if hotspot.selected() and now >= maintain_at:
            maintain_at = now + 15
            try:
                await asyncio.to_thread(hotspot.operate, "Start")
            except (OSError, RuntimeError, TimeoutError):
                logging.exception("Windows hotspot unavailable")
                report.update("network_error")
            else:
                if report.data["phase"] == "network_error":
                    report.update("listening")
        try:
            address = await asyncio.to_thread(discover)
            if address:
                report.update("connecting")
                await voice_session(address, context, pairing, report)
        except (OSError, ValueError, RuntimeError, TimeoutError) as exc:
            logging.warning("Voice connection ended: %s", type(exc).__name__)
            if report.data["phase"] in {"connecting", "receiving", "finishing"}:
                report.update("listening", last="CONNECTION_ERROR")
        except Exception:
            logging.exception("Unexpected voice session error")
            report.update("listening", last="CONNECTION_ERROR")
        report.flush()
        await asyncio.sleep(0.45)


async def check_codex():
    codex = Codex()
    try:
        await codex.start()
        account = await codex.request("account/read", {"refreshToken": False})
        if not account.get("account"):
            raise RuntimeError("Open Codex and sign in to use Air Remote voice")
        print("Codex app server authenticated; no prompt was sent.")
    finally:
        await codex.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-codex", action="store_true")
    args = parser.parse_args()
    if args.check_codex:
        asyncio.run(check_codex())
        return
    run_service()


def run_service():
    if not provisioned() or not preferences():
        return
    instance = claim_service()
    if not instance:
        return
    try:
        logging.basicConfig(
            handlers=[RotatingFileHandler(LOCAL / "companion.log", maxBytes=512000,
                                          backupCount=2, encoding="utf-8")],
            level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
        )
        report = ServiceStatus()
        try:
            report.update("loading")
            asyncio.run(serve(report))
            report.update("stopped")
        except Exception:
            logging.exception("Companion stopped")
            report.update("error")
    finally:
        kernel.CloseHandle(instance)


if __name__ == "__main__":
    main()
