import hashlib
from pathlib import Path
import ssl
import sys
from tempfile import TemporaryDirectory
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from init_pairing import initialize


class PairingTests(unittest.TestCase):
    def test_unique_and_reusable(self):
        with TemporaryDirectory() as scratch:
            first, second = Path(scratch) / "first", Path(scratch) / "second"
            self.assertTrue(initialize(first))
            before = {path.name: (hashlib.sha256(path.read_bytes()).digest(), path.stat().st_mtime_ns)
                      for path in first.iterdir()}
            self.assertFalse(initialize(first))
            self.assertEqual(before, {path.name: (hashlib.sha256(path.read_bytes()).digest(), path.stat().st_mtime_ns)
                                      for path in first.iterdir()})
            self.assertTrue(initialize(second))
            self.assertNotEqual((first / "pairing.txt").read_bytes(), (second / "pairing.txt").read_bytes())
            self.assertNotEqual((first / "server.key").read_bytes(), (second / "server.key").read_bytes())
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(first / "server.crt", first / "server.key")
            ssl.create_default_context(cafile=str(first / "server.crt"))

    def test_partial_files_are_preserved(self):
        with TemporaryDirectory() as scratch:
            folder = Path(scratch)
            token = folder / "pairing.txt"
            token.write_text("keep-this", encoding="ascii")
            with self.assertRaises(FileExistsError):
                initialize(folder)
            self.assertEqual(token.read_text(encoding="ascii"), "keep-this")
            self.assertEqual([path.name for path in folder.iterdir()], ["pairing.txt"])

    def test_mismatched_certificate_is_rejected(self):
        with TemporaryDirectory() as scratch:
            first, second = Path(scratch) / "first", Path(scratch) / "second"
            initialize(first)
            initialize(second)
            (first / "server.key").write_bytes((second / "server.key").read_bytes())
            with self.assertRaisesRegex(ValueError, "do not match"):
                initialize(first)


if __name__ == "__main__":
    unittest.main()
