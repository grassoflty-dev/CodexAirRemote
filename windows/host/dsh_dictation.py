"""Drive the DeepSeek Harness experimental voice input by accessibility.

DSH's voice input is a client plugin: a microphone trigger in the composer and a
recording toolbar with Cancel / Stop. Stopping transcribes the recording into
the conversation draft (DSH never sends on its own).
"""

import asyncio
import json
import logging
from pathlib import Path
import subprocess

SCRIPT = Path(__file__).with_name("dsh_dictation.ps1")


class DshUnavailable(RuntimeError):
    """The DSH voice controls cannot be driven automatically."""


class DshSetupRequired(DshUnavailable):
    """DSH's local recognition model (SenseVoice) has not been prepared yet."""


async def control(operation, session=None):
    args = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", str(SCRIPT), "-Operation", operation]
    if session:
        args.extend(("-Window", str(session.get("window", 0)), "-Recording", session.get("recording", "")))
    process = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    try:
        output, error = await asyncio.wait_for(process.communicate(), 20)
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.wait()
        raise
    text = (output or b"").decode("utf-8", "replace").strip()
    if process.returncode:
        logging.warning("DSH voice input %s: %s", operation,
                        (error or b"").decode("utf-8", "replace").strip()[:400])
        raise RuntimeError("DSH voice input control unavailable")
    try:
        result = json.loads(text.splitlines()[-1]) if text else {}
    except ValueError as exc:
        raise RuntimeError("Unexpected DSH voice input response") from exc
    if not result.get("ok"):
        reason = result.get("reason", "unknown")
        if reason == "setup_required":
            raise DshSetupRequired(reason)
        if reason in {"automation_unavailable", "window_not_found", "not_recording"}:
            raise DshUnavailable(reason)
        raise RuntimeError(f"DSH voice input {operation}: {reason}")
    return result
