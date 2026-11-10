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
import time

from websockets.asyncio.client import connect

from app_runtime import LOCAL, ServiceStatus, claim_service, kernel, preferences, provisioned
from codex_adapter import Codex
from virtual_mic import CablePlayback, CableSetupError, cable_device
from voice_target import SetupRequired, select_target
import hotspot

DISCOVERY_PORT = 47682
VOICE_PORT = 47683
MAX_PCM_BYTES = 60 * 16000 * 2
DISCOVERY_PREFIX = b"AR1?"
DISCOVERY_ANNOUNCEMENT = b"AR1A"
DISCOVERY_WINDOW = 0.6


def _peer_address(reply, peer, nonce):
    """Return the board address for a discovery datagram, or None."""
    source = ipaddress.IPv4Address(peer[0])
    if peer[1] != DISCOVERY_PORT or not source.is_private:
        return None
    # Windows' mobile hotspot drops the host's broadcasts on the way to its
    # clients, so the board announces itself with a unicast AR1A datagram to
    # the gateway (this PC) instead of relying on a broadcast reply.
    if len(reply) == 10 and reply.startswith(DISCOVERY_ANNOUNCEMENT):
        return peer[0]
    if reply == b"AR1!" + nonce:
        return peer[0]
    return None


def discover():
    nonce = secrets.token_bytes(16)
    broadcast = "192.168.137.255" if hotspot.selected() else "255.255.255.255"
    try:
        return _discover_listening(nonce, broadcast)
    except OSError:
        # The port is already taken (another instance or a probe); fall back to
        # the broadcast-only query, which still works on normal access points.
        return _discover_querying(nonce, broadcast)


def _discover_listening(nonce, broadcast):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        udp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        udp.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        udp.bind(("0.0.0.0", DISCOVERY_PORT))
        udp.sendto(DISCOVERY_PREFIX + nonce, (broadcast, DISCOVERY_PORT))
        deadline = time.monotonic() + DISCOVERY_WINDOW
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            udp.settimeout(remaining)
            try:
                reply, peer = udp.recvfrom(64)
            except TimeoutError:
                return None
            address = _peer_address(reply, peer, nonce)
            if address:
                return address


def _discover_querying(nonce, broadcast):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        udp.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        udp.settimeout(DISCOVERY_WINDOW)
        udp.sendto(DISCOVERY_PREFIX + nonce, (broadcast, DISCOVERY_PORT))
        while True:
            try:
                reply, peer = udp.recvfrom(64)
            except TimeoutError:
                return None
            address = _peer_address(reply, peer, nonce)
            if address:
                return address


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
    target = select_target()
    status = "FAILED"
    try:
        playback_error = None
        try:
            playback = CablePlayback(cable_device())
        except CableSetupError as exc:
            status = str(exc)
            playback_error = exc
        logging.info("Voice target: %s", target.name)
        if playback_error is None:
            try:
                session = await target.start()
            except SetupRequired as exc:
                status = "DSH_SETUP_REQUIRED"
                logging.warning("Dictation target needs setup: %s", exc)
            except (OSError, RuntimeError, TimeoutError, ValueError) as exc:
                status = "DSH_UNAVAILABLE" if target.name == "dsh" else "DICTATION_UNAVAILABLE"
                logging.warning("Could not start %s dictation: %s", target.name, exc)
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
            try:
                await target.cancel(session)
            except (OSError, RuntimeError, TimeoutError, ValueError):
                logging.warning("The %s recording could not be cancelled automatically", target.name)
            session = None
            status = "CANCELLED" if action == "CANCEL" else "EMPTY"
            return ("CANCELLED" if modern and action == "CANCEL" else "EMPTY"), status
        if report:
            report.update("finishing")
        await playback.drain()
        # A lost reply after invoking a send leaves its outcome unknown. Never invoke it again.
        status = await target.finish(session, action)
        session = None
        if status == "DRAFTED":
            return "DRAFTED", "DRAFTED"
        if status == "DSH_MANUAL":
            return "DRAFTED", "DSH_MANUAL"
        return ("SUBMITTED" if modern else "SENT"), status
    finally:
        try:
            if playback is not None:
                playback.close()
        finally:
            if session is not None:
                try:
                    await target.cancel(session)
                except (OSError, RuntimeError, TimeoutError, ValueError):
                    logging.warning("The %s recording could not be cancelled automatically", target.name)


async def voice_session(address, context, pairing, report=None):
    async with connect(
        f"wss://{address}:{VOICE_PORT}/voice", ssl=context, server_hostname="airremote.local",
        proxy=None, open_timeout=20, close_timeout=1, ping_interval=None, max_size=4096,
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
    # The ESP32-C6 firmware ships a TLS 1.2-only mbedTLS build to fit its
    # 512 KiB SRAM; a default OpenSSL client would offer TLS 1.3 and the board
    # rejects that ClientHello. Pin both versions to 1.2.
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.maximum_version = ssl.TLSVersion.TLSv1_2
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
