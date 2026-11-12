"""ARC-02: the v2 baseline matches the replayed v1 schema, apart from the listed differences,
and the committed baseline file is what the generator produces today."""

from app.db.catalog import diff_catalogs
from app.db.introspect import read_schema
from app.db.parity import ALLOWED, to_catalog
from tests.conftest import requires_db


@requires_db
def test_v2_matches_v1_except_allowed_differences(v1_replay_db: str, v2_baseline_db: str) -> None:
    v1 = to_catalog(read_schema(v1_replay_db), v1=True)
    v2 = to_catalog(read_schema(v2_baseline_db), v1=False)
    diffs = diff_catalogs(v1, v2, ALLOWED)
    report = "\n".join(
        f"{d.kind:8} {d.section}: {d.key}\n  v1: {d.ref}\n  v2: {d.new}" for d in diffs
    )
    assert diffs == [], f"{len(diffs)} unexpected v1↔v2 differences:\n{report}"


@requires_db
def test_committed_baseline_is_up_to_date() -> None:
    from scripts.gen_baseline import OUT, generate

    assert OUT.read_text(encoding="utf-8") == generate(), (
        "migrations/sql/0001_baseline.sql is stale: run `python -m scripts.gen_baseline`"
    )
