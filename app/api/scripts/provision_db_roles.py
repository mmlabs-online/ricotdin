"""Create/rotate the runtime database logins and write their URLs to an env file (ARC-04).

    cd app/api
    uv run --env-file .env python -m scripts.provision_db_roles            # writes .env
    uv run --env-file .env python -m scripts.provision_db_roles --env-file other.env

Uses DATABASE_URL (the owner) to create ricotdin_api_login / ricotdin_service_login /
ricotdin_worker_login (NOINHERIT, one group each, timeouts, connection limits) and sets
DATABASE_URL_APP / _SERVICE / _WORKER in the env file. Re-running rotates every password.
Prints only role names. Run after `alembic upgrade head` (the groups must exist).
"""

import argparse
import os
import sys
from pathlib import Path

from app.db.provision import GROUP_LOGINS, ensure_login
from app.db.replay import API_ROOT


def _set_env_line(lines: list[str], key: str, value: str) -> list[str]:
    out = [line for line in lines if not line.startswith(f"{key}=")]
    out.append(f"{key}={value}")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", default=str(API_ROOT / ".env"))
    args = parser.parse_args()
    owner = os.environ.get("DATABASE_URL", "")
    if not owner:
        print("DATABASE_URL (owner) is not set", file=sys.stderr)
        return 2
    env_path = Path(args.env_file)
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
    for group, (name, env_key, limit) in GROUP_LOGINS.items():
        login = ensure_login(owner, group, name, connection_limit=limit)
        lines = _set_env_line(lines, env_key, login.url(owner))
        print(f"{name}: member of {group} only, NOINHERIT, connection limit {limit} -> {env_key}")
    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"updated {env_path.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
