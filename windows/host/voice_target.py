"""Selectable dictation targets for a board voice session.

Two targets are supported:

* ``codex`` - Codex desktop dictation (existing behaviour). Board audio goes to
  VB-CABLE, then the Codex desktop dictation controls are driven by
  accessibility (``dictation.py`` / ``dictation.ps1``).
* ``dsh``   - DeepSeek Harness experimental voice input. Board audio goes to
  VB-CABLE, the DSH voice input picks it up as its microphone, and DSH's local
  SenseVoice model transcribes the recording into the conversation draft. The
  composer microphone / Stop buttons are driven by accessibility
  (``dsh_dictation.py``); when the Chromium accessibility tree is unavailable the
  target degrades to *manual* mode: the companion keeps feeding audio and the
  user starts/stops DSH's microphone by hand.

The selection lives in ``.local/companion-settings.json`` (``voice_target``) and
is read for every session, so switching targets in the Windows UI takes effect
on the next Voice session without restarting the service.
"""

import logging

from app_runtime import DEFAULT_VOICE_TARGET, VOICE_TARGETS, voice_target
from dictation import control as codex_control
import dsh_dictation

CODEX = "codex"
DSH = "dsh"


class DictationError(RuntimeError):
    """A dictation target could not be started."""


class SetupRequired(DictationError):
    """The target exists but needs a one-time setup (e.g. DSH model download)."""


class CodexTarget:
    """Codex desktop dictation (unchanged legacy path)."""

    name = CODEX

    async def start(self):
        return await codex_control("Start")

    async def finish(self, session, action):
        command = "Draft" if action == "DRAFT" else "Send"
        await codex_control(command, session)
        return "DRAFTED" if command == "Draft" else "SUBMITTED"

    async def cancel(self, session):
        await codex_control("Cancel", session)


class DshTarget:
    """DeepSeek Harness experimental voice input."""

    name = DSH

    def __init__(self):
        self.manual = False

    async def start(self):
        try:
            session = await dsh_dictation.control("Start")
        except dsh_dictation.DshSetupRequired as exc:
            raise SetupRequired("DSH 语音输入模型尚未准备") from exc
        except dsh_dictation.DshUnavailable as exc:
            # Chromium does not expose its accessibility tree unless DSH enables
            # it. Keep streaming audio anyway so a manually started recording
            # still captures the board microphone.
            self.manual = True
            logging.warning(
                "DSH voice controls are not automatable (%s); "
                "click the DSH microphone before speaking and Stop afterwards", exc)
            return {"manual": True}
        session["manual"] = False
        return session

    async def finish(self, session, action):
        if session.get("manual"):
            # Nothing to press: the user stops DSH's recording by hand. DSH
            # inserts the transcript into the draft and never sends on its own.
            return "DSH_MANUAL"
        await dsh_dictation.control("Stop", session)
        return "DRAFTED"

    async def cancel(self, session):
        if session.get("manual"):
            return
        await dsh_dictation.control("Cancel", session)


def select_target(name=None):
    """Return the configured target instance (unknown values fall back to Codex)."""
    chosen = name if name in VOICE_TARGETS else voice_target()
    if chosen not in VOICE_TARGETS:
        chosen = DEFAULT_VOICE_TARGET
    if chosen == DSH:
        return DshTarget()
    return CodexTarget()
