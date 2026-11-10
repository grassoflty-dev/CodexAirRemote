"""Verify the encrypted board protocol with simulated audio and dictation targets.

Runs entirely against localhost with mocked dictation controls: no board, no
Codex/DSH installation and no VB-CABLE are required.
"""

import asyncio
import ssl
import struct
from unittest.mock import patch

from websockets.asyncio.server import serve

import companion
import dsh_dictation
import voice_target
from app_runtime import LOCAL

PCM = bytes(6400)
SESSION = {"window": 42, "recording": "1.2.3"}


async def protocol_check(action, expected_reply, operations, *, modern=True, failure=None,
                         target="codex", manual=False, starts=True, expected_control=None):
    pairing = (LOCAL / "pairing.txt").read_text(encoding="ascii").strip()
    client_context = ssl.create_default_context(cafile=str(LOCAL / "server.crt"))
    # Board firmware is TLS 1.2-only (see companion.py).
    client_context.minimum_version = ssl.TLSVersion.TLSv1_2
    client_context.maximum_version = ssl.TLSVersion.TLSv1_2
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(LOCAL / "server.crt", LOCAL / "server.key")
    completed = asyncio.get_running_loop().create_future()
    calls = []
    dsh_calls = []

    class Playback:
        def __init__(self, endpoint):
            assert endpoint == 7
            self.audio = bytearray()

        async def write(self, pcm):
            self.audio.extend(pcm)

        async def drain(self):
            assert self.audio == PCM
            calls.append("Drain")

        def close(self):
            calls.append("Close")

    def device():
        if failure == "cable":
            raise companion.CableSetupError("CABLE_MISSING")
        return 7

    async def codex_control(operation, session=None):
        assert session == (None if operation == "Start" else SESSION)
        calls.append(operation)
        if operation == "Send" and failure == "send":
            raise TimeoutError("Simulated loss of send response")
        return SESSION if operation == "Start" else {"ok": True}

    async def dsh_control(operation, session=None):
        dsh_calls.append(operation)
        if failure == "dsh_setup":
            raise dsh_dictation.DshSetupRequired("setup_required")
        if manual:
            raise dsh_dictation.DshUnavailable("automation_unavailable")
        if operation == "Start":
            return {"window": 7, "recording": "7.1", "manual": False}
        return {"ok": True}

    def chosen():
        return voice_target.DshTarget() if target == "dsh" else voice_target.CodexTarget()

    async def board(ws):
        try:
            assert await ws.recv() == "AUTH " + pairing
            await ws.send("READY2" if modern else "READY")
            if starts and (failure != "cable" or not modern):
                if modern:
                    assert await ws.recv() == "CAPTURE"
                    await ws.send("GO")
                for sequence in range(2):
                    assert await ws.recv() == "PULL"
                    await ws.send(struct.pack("!I", sequence) + PCM[:3200])
                assert await ws.recv() == "PULL"
                await ws.send(action)
            assert await ws.recv() == expected_reply
            await ws.send("ACK")
            completed.set_result(None)
        except Exception as exc:
            completed.set_exception(exc)

    with (patch.object(companion, "cable_device", device),
          patch.object(companion, "CablePlayback", Playback),
          patch.object(voice_target, "codex_control", codex_control),
          patch.object(dsh_dictation, "control", dsh_control),
          patch.object(companion, "select_target", chosen)):
        async with serve(board, "127.0.0.1", 0, ssl=server_context) as server:
            port = server.sockets[0].getsockname()[1]
            with patch.object(companion, "VOICE_PORT", port):
                await companion.voice_session("127.0.0.1", client_context, pairing)
            try:
                await asyncio.wait_for(completed, 3)
            except Exception as exc:
                raise AssertionError(
                    f"scenario failed: target={target} action={action} failure={failure} "
                    f"manual={manual} modern={modern} starts={starts}") from exc
    assert calls == operations, (target, calls)
    if expected_control is not None:
        assert dsh_calls == expected_control, dsh_calls
    else:
        assert not dsh_calls, dsh_calls


async def main():
    # Codex target: unchanged legacy behaviour must not regress.
    await protocol_check("SEND", "SUBMITTED", ["Start", "Drain", "Send", "Close"])
    await protocol_check("DRAFT", "DRAFTED", ["Start", "Drain", "Draft", "Close"])
    await protocol_check("CANCEL", "CANCELLED", ["Start", "Close", "Cancel"])
    await protocol_check("STOP", "SENT", ["Start", "Drain", "Send", "Close"], modern=False)
    await protocol_check("SEND", "ABORT", [], failure="cable", starts=False)
    await protocol_check("STOP", "FAILED", [], modern=False, failure="cable")
    await protocol_check("SEND", "ABORT", ["Start", "Drain", "Send", "Close", "Cancel"], failure="send")

    # DeepSeek Harness target: stop/transcribe only, never auto-sends.
    await protocol_check("SEND", "DRAFTED", ["Drain", "Close"],
                         target="dsh", expected_control=["Start", "Stop"])
    await protocol_check("DRAFT", "DRAFTED", ["Drain", "Close"],
                         target="dsh", expected_control=["Start", "Stop"])
    await protocol_check("CANCEL", "CANCELLED", ["Close"],
                         target="dsh", expected_control=["Start", "Cancel"])
    # Accessibility unavailable: companion only feeds CABLE, the user drives DSH.
    await protocol_check("SEND", "DRAFTED", ["Drain", "Close"],
                         target="dsh", manual=True, expected_control=["Start"])
    # DSH model not prepared / DSH missing: explicit abort instead of silent fallback.
    await protocol_check("SEND", "ABORT", ["Close"], target="dsh", failure="dsh_setup",
                         starts=False, expected_control=["Start"])
    await protocol_check("SEND", "ABORT", [], target="dsh", failure="cable",
                         starts=False, expected_control=[])
    print("Encrypted audio, Codex submit/draft/cancel/legacy, DSH draft/cancel/manual/setup, "
          "missing cable, and ambiguous send passed.")


if __name__ == "__main__":
    asyncio.run(main())
