"""Create per-checkout TLS and pairing material; never replace existing keys."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
import secrets
import tempfile

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


def initialize(folder):
    folder = Path(folder)
    paths = [folder / name for name in ("server.crt", "server.key", "pairing.txt")]
    present = [path.exists() for path in paths]
    if any(present):
        if not all(present):
            raise FileExistsError("Incomplete pairing files; preserve them and restore the missing files before continuing.")
        cert = x509.load_pem_x509_certificate(paths[0].read_bytes())
        key = serialization.load_pem_private_key(paths[1].read_bytes(), password=None)
        if cert.public_key().public_numbers() != key.public_key().public_numbers():
            raise ValueError("The existing certificate and private key do not match.")
        names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        if "airremote.local" not in names.get_values_for_type(x509.DNSName):
            raise ValueError("The existing certificate is not for airremote.local.")
        pairing = paths[2].read_text(encoding="ascii").strip()
        if len(pairing) != 64 or any(char not in "0123456789abcdef" for char in pairing):
            raise ValueError("The existing pairing token is invalid.")
        return False

    folder.mkdir(parents=True, exist_ok=True)
    # ECDSA P-256: much faster and lighter than RSA-2048 on the ESP32-C6,
    # whose TLS handshake has to fit inside 512 KiB of SRAM.
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "airremote.local")])
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=3650))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("airremote.local")]), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False,
                                    key_encipherment=False, data_encipherment=False,
                                    key_agreement=False, key_cert_sign=True, crl_sign=True,
                                    encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(key, hashes.SHA256())
    )
    payloads = [
        cert.public_bytes(serialization.Encoding.PEM),
        key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                          serialization.NoEncryption()),
        (secrets.token_hex(32) + "\n").encode("ascii"),
    ]
    # Exclusive writes preserve any files created by a concurrent initializer.
    with tempfile.TemporaryDirectory(prefix="pairing-", dir=folder) as scratch:
        for path, data in zip(paths, payloads):
            pending = Path(scratch) / path.name
            pending.write_bytes(data)
            pending.chmod(0o600)
        for path in paths:
            # Path.rename on Windows fails if a destination already exists.
            (Path(scratch) / path.name).rename(path)
    return True


if __name__ == "__main__":
    created = initialize(Path(__file__).resolve().parents[1] / ".local")
    print("Created local pairing files." if created else "Preserved existing local pairing files.")
