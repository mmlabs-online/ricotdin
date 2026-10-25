"""ARC-02: scratch database URLs keep the URL form (SQLAlchemy cannot parse key=value DSNs)."""

from app.db.scratch import url_for


def test_url_for_swaps_only_the_database_name() -> None:
    base = (
        "postgresql://neondb_owner:p%40ss@ep-x.ap-southeast-1.aws.neon.tech/neondb?sslmode=require"
    )
    assert url_for("ricotdin_test_v2_ab12", base) == (
        "postgresql://neondb_owner:p%40ss@ep-x.ap-southeast-1.aws.neon.tech/ricotdin_test_v2_ab12"
        "?sslmode=require"
    )


def test_url_for_without_query_or_port() -> None:
    assert (
        url_for("x", "postgresql://u@localhost:5432/postgres") == "postgresql://u@localhost:5432/x"
    )
