"""Verify the encrypted board protocol with simulated audio and dictation."""

import asyncio
import ssl
import struct
from unittest.mock import patch

from websockets.asyncio.server import serve

import companion
from app_runtime import LOCAL

PCM = bytes(6400)
SESSION = {"window": 42, "recording": "1.2.3"}


async def protocol_check(action, expected_reply, operations, *, modern=True, failure=None):
    pairing = (LOCAL / "pairing.txt").read_text(encoding="ascii").strip()
    client_context = ssl.create_default_context(cafile=str(LOCAL / "server.crt"))
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(LOCAL / "server.crt", LOCAL / "server.key")
    completed = asyncio.get_running_loop().create_future()
    calls = []

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

    async def control(operation, session=None):
        assert session == (None if operation == "Start" else SESSION)
        calls.append(operation)
        if operation == "Send" and failure == "send":
            raise TimeoutError("Simulated loss of send response")
        return SESSION if operation == "Start" else {"ok": True}

    async def board(ws):
        try:
            assert await ws.recv() == "AUTH " + pairing
            await ws.send("READY2" if modern else "READY")
            if failure != "cable" or not modern:
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
          patch.object(companion, "control", control)):
        async with serve(board, "127.0.0.1", 0, ssl=server_context) as server:
            port = server.sockets[0].getsockname()[1]
            with patch.object(companion, "VOICE_PORT", port):
                await companion.voice_session("127.0.0.1", client_context, pairing)
            await asyncio.wait_for(completed, 3)
    assert calls == operations, (action, calls)


async def main():
    await protocol_check("SEND", "SUBMITTED", ["Start", "Drain", "Send", "Close"])
    await protocol_check("DRAFT", "DRAFTED", ["Start", "Drain", "Draft", "Close"])
    await protocol_check("CANCEL", "CANCELLED", ["Start", "Close", "Cancel"])
    await protocol_check("STOP", "SENT", ["Start", "Drain", "Send", "Close"], modern=False)
    await protocol_check("SEND", "ABORT", [], failure="cable")
    await protocol_check("STOP", "FAILED", [], modern=False, failure="cable")
    await protocol_check("SEND", "ABORT", ["Start", "Drain", "Send", "Close", "Cancel"], failure="send")
    print("Encrypted audio, submit, draft, cancel, legacy, missing cable, and ambiguous send passed.")


if __name__ == "__main__":
    asyncio.run(main())
