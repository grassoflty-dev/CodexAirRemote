"""Call the desktop dictation controls using their accessibility names."""

import asyncio
import json
import logging
from pathlib import Path
import subprocess

SCRIPT = Path(__file__).with_name("dictation.ps1")


async def control(operation, session=None):
    args = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", str(SCRIPT), "-Operation", operation]
    if session:
        args.extend(("-Window", str(session["window"]), "-Recording", session["recording"]))
    process = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    try:
        output, error = await asyncio.wait_for(process.communicate(), 15)
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.wait()
        raise
    if process.returncode:
        logging.warning("Codex dictation %s: %s", operation, error.decode("utf-8", "replace").strip()[:400])
        raise RuntimeError("Codex dictation control unavailable")
    return json.loads(output)
