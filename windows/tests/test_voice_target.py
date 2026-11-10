"""Unit tests for the selectable dictation target.

Only the local settings file is touched (redirected to a temporary directory);
no board, Codex, DSH or audio device is required.
"""

import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

HOST = Path(__file__).resolve().parents[1] / "host"
sys.path.insert(0, str(HOST))

import app_runtime  # noqa: E402
import voice_target  # noqa: E402


class VoiceTargetSettingsTests(unittest.TestCase):
    def setUp(self):
        self.scratch = TemporaryDirectory()
        self.preferences = Path(self.scratch.name) / "companion-settings.json"
        self.patch = patch.object(app_runtime, "PREFERENCES", self.preferences)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.scratch.cleanup()

    def test_defaults_to_codex(self):
        self.assertEqual(app_runtime.voice_target(), "codex")

    def test_round_trip_keeps_enabled_flag(self):
        app_runtime.set_preferences(True)
        app_runtime.set_voice_target("dsh")
        self.assertEqual(app_runtime.voice_target(), "dsh")
        self.assertTrue(app_runtime.preferences())
        app_runtime.set_preferences(False)
        self.assertEqual(app_runtime.voice_target(), "dsh")
        self.assertFalse(app_runtime.preferences())

    def test_invalid_value_resets_to_codex(self):
        app_runtime.set_voice_target("unknown")
        self.assertEqual(app_runtime.voice_target(), "codex")
        stored = json.loads(self.preferences.read_text(encoding="utf-8"))
        self.assertEqual(stored["voice_target"], "codex")

    def test_unknown_stored_value_falls_back_to_codex(self):
        self.preferences.write_text(json.dumps({"enabled": True, "voice_target": "other"}),
                                    encoding="utf-8")
        self.assertEqual(app_runtime.voice_target(), "codex")


class TargetSelectionTests(unittest.TestCase):
    def test_configured_codex(self):
        with patch.object(voice_target, "voice_target", return_value="codex"):
            self.assertIsInstance(voice_target.select_target(), voice_target.CodexTarget)

    def test_configured_dsh(self):
        with patch.object(voice_target, "voice_target", return_value="dsh"):
            self.assertIsInstance(voice_target.select_target(), voice_target.DshTarget)

    def test_explicit_name_wins_over_settings(self):
        with patch.object(voice_target, "voice_target", return_value="dsh"):
            self.assertIsInstance(voice_target.select_target("codex"), voice_target.CodexTarget)

    def test_invalid_stored_value_uses_codex(self):
        with patch.object(voice_target, "voice_target", return_value="bogus"):
            self.assertIsInstance(voice_target.select_target(), voice_target.CodexTarget)


class DshTargetTests(unittest.IsolatedAsyncioTestCase):
    async def test_manual_fallback_when_automation_is_unavailable(self):
        target = voice_target.DshTarget()

        async def unavailable(*args, **kwargs):
            raise voice_target.dsh_dictation.DshUnavailable("automation_unavailable")

        with patch.object(voice_target.dsh_dictation, "control", unavailable):
            session = await target.start()
        self.assertTrue(session["manual"])
        self.assertEqual(await target.finish(session, "SEND"), "DSH_MANUAL")
        await target.cancel(session)  # manual sessions have no control to cancel

    async def test_unprepared_model_is_reported(self):
        target = voice_target.DshTarget()

        async def setup(*args, **kwargs):
            raise voice_target.dsh_dictation.DshSetupRequired("setup_required")

        with self.assertRaises(voice_target.SetupRequired):
            with patch.object(voice_target.dsh_dictation, "control", setup):
                await target.start()

    async def test_stop_transcribes_into_draft(self):
        target = voice_target.DshTarget()
        session = {"window": 1, "recording": "1.2", "manual": False}

        async def ok(operation, session=None):
            self.assertEqual(operation, "Stop")
            return {"ok": True}

        with patch.object(voice_target.dsh_dictation, "control", ok):
            self.assertEqual(await target.finish(session, "SEND"), "DRAFTED")


if __name__ == "__main__":
    unittest.main()
