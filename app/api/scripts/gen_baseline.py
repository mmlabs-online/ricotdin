"""Generate migrations/sql/0001_baseline.sql from the v1 schema (ARC-02).

Replays the frozen v1 schema (tests/fixtures/v1/schema) into a scratch database (Supabase shim),
reads the catalog and renders the v2 baseline with the hand-written prelude/epilogue/overrides.

    cd app/api
    uv run --env-file .env python -m scripts.gen_baseline           # write the file
    uv run --env-file .env python -m scripts.gen_baseline --check   # exit 1 if it is stale
"""

import argparse
import sys

from app.db.baseline import render_baseline
from app.db.introspect import read_schema
from app.db.parity import OVERRIDDEN_FUNCTIONS, SKIPPED_V1_FUNCTIONS
from app.db.replay import API_ROOT, replay_v1
from app.db.scratch import drop_stale, scratch_database

SRC = API_ROOT / "migrations" / "src"
OUT = API_ROOT / "migrations" / "sql" / "0001_baseline.sql"


def generate() -> str:
    with scratch_database("v1gen") as url:
        replay_v1(url)
        schema = read_schema(url)
    overrides = {
        name: (SRC / "overrides" / f"{name}.sql").read_text(encoding="utf-8")
        for name in sorted(OVERRIDDEN_FUNCTIONS)
    }
    return render_baseline(
        schema,
        prelude=(SRC / "v2_prelude.sql").read_text(encoding="utf-8"),
        epilogue=(SRC / "v2_epilogue.sql").read_text(encoding="utf-8"),
        overrides=overrides,
        skip_functions=SKIPPED_V1_FUNCTIONS,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if the committed file is stale")
    args = parser.parse_args()
    drop_stale()  # leftovers of interrupted runs; never inside generate() (tests call it)
    sql = generate()
    if args.check:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current != sql:
            print(
                f"{OUT.relative_to(API_ROOT)} is stale: run python -m scripts.gen_baseline",
                file=sys.stderr,
            )
            return 1
        print("baseline up to date")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(sql, encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(API_ROOT)} ({len(sql.splitlines())} lines)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
