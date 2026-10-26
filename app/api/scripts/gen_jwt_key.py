"""Generate the Ed25519 signing key for access tokens and write JWT_PRIVATE_KEY (ARC-05).

    cd app/api
    uv run python -m scripts.gen_jwt_key                  # adds JWT_PRIVATE_KEY to .env if missing
    uv run python -m scripts.gen_jwt_key --rotate         # replace it (sessions end within 15 min)
    uv run python -m scripts.gen_jwt_key --env-file prod.env

The key is stored on one line with escaped newlines (``\\n``), written atomically (mode 0600) and
never printed — only its key id (public thumbprint) is.
"""

import argparse
import sys
from pathlib import Path

from app.auth.jwt import JwtKeys, generate_private_pem
from app.db.provision import set_env_line, write_env_atomic
from app.db.replay import API_ROOT

KEY = "JWT_PRIVATE_KEY"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", default=str(API_ROOT / ".env"))
    parser.add_argument("--rotate", action="store_true", help="replace an existing key")
    args = parser.parse_args()
    env_path = Path(args.env_file)
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
    if any(line.strip().startswith(f"{KEY}=") for line in lines) and not args.rotate:
        print(f"{KEY} already set in {env_path.name} (use --rotate to replace it)")
        return 0
    pem = generate_private_pem()
    kid = JwtKeys.from_private_pem(pem).kid
    write_env_atomic(
        env_path, set_env_line(lines, KEY, '"' + pem.strip().replace("\n", "\\n") + '"')
    )
    print(f"{KEY} written to {env_path.name} (kid {kid})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
