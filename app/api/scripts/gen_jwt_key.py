"""Generate the Ed25519 signing key for access tokens and write JWT_PRIVATE_KEY (ARC-05).

    cd app/api
    uv run python -m scripts.gen_jwt_key                  # adds JWT_PRIVATE_KEY to .env if missing
    uv run python -m scripts.gen_jwt_key --rotate         # replace; old public key kept 16 min
    uv run python -m scripts.gen_jwt_key --env-file prod.env

The key is stored on one line with escaped newlines (``\\n``), written atomically (mode 0600) and
never printed — only its key id (public thumbprint) is. ``--rotate`` moves the old key's PUBLIC
half to JWT_PREVIOUS_PUBLIC_KEY so access tokens it signed keep working until they expire
(15 min); remove that line afterwards. Refresh sessions are database rows and survive rotation.
After a suspected key leak, also revoke every refresh token (a leaked key can mint admin tokens).
"""

import argparse
import sys
from pathlib import Path

from app.auth.jwt import JwtKeys, generate_private_pem
from app.db.provision import set_env_line, write_env_atomic
from app.db.replay import API_ROOT

KEY = "JWT_PRIVATE_KEY"
PREVIOUS = "JWT_PREVIOUS_PUBLIC_KEY"


def _one_line(pem: str) -> str:
    return '"' + pem.strip().replace("\n", "\\n") + '"'


def _current(lines: list[str]) -> str | None:
    for line in lines:
        if line.strip().startswith(f"{KEY}="):
            return line.split("=", 1)[1].strip().strip('"')
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", default=str(API_ROOT / ".env"))
    parser.add_argument("--rotate", action="store_true", help="replace an existing key")
    args = parser.parse_args()
    env_path = Path(args.env_file)
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
    current = _current(lines)
    if current and not args.rotate:
        print(f"{KEY} already set in {env_path.name} (use --rotate to replace it)")
        return 0
    if current:
        old = JwtKeys.from_private_pem(current)
        lines = set_env_line(lines, PREVIOUS, _one_line(old.public_pem.decode()))
        print(f"{PREVIOUS} set to the old kid {old.kid} (remove it after 16 minutes)")
    pem = generate_private_pem()
    kid = JwtKeys.from_private_pem(pem).kid
    write_env_atomic(env_path, set_env_line(lines, KEY, _one_line(pem)))
    print(f"{KEY} written to {env_path.name} (kid {kid})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
