"""Create/rotate the runtime database logins and write their URLs to an env file (ARC-04).

    cd app/api
    uv run --env-file .env python -m scripts.provision_db_roles            # writes .env
    uv run --env-file .env python -m scripts.provision_db_roles --env-file other.env

Uses DATABASE_URL (the owner) to create ricotdin_api_login / ricotdin_service_login /
ricotdin_worker_login (one group each, WITH INHERIT FALSE, timeouts, connection limits) and sets
DATABASE_URL_APP / _SERVICE / _WORKER in the env file. Re-running rotates every password; the
file is rewritten (atomically, mode 0600) right after each rotation so a failure on a later
login never leaves an earlier new password unrecorded. Prints only role names.
Run after `alembic upgrade head` (the groups must exist).
"""

import argparse
import os
import sys
from pathlib import Path

from app.db.provision import GROUP_LOGINS, ensure_login, set_env_line, write_env_atomic
from app.db.replay import API_ROOT


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
        lines = set_env_line(lines, env_key, login.url(owner))
        write_env_atomic(env_path, lines)
        print(f"{name}: member of {group} only, connection limit {limit} -> {env_key}")
    print(f"updated {env_path.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
