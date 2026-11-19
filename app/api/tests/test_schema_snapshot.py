"""Schema snapshots compare SQL fragments in a canonical form (``app.db.parity.normalize_sql``)."""

from app.db.parity import normalize_sql


def test_normalize_sql_ignores_public_schema_qualification() -> None:
    a = "REFERENCES public.users(id) WHERE public.app_user_id() = x"
    b = "REFERENCES users(id) WHERE app_user_id() = x"
    assert normalize_sql(a) == normalize_sql(b)


def test_normalize_sql_collapses_whitespace_and_keeps_text() -> None:
    assert normalize_sql("  SELECT   1  ") == "SELECT 1"
    assert normalize_sql("(app_user_id() = user_id)\n  OR x") == "(app_user_id() = user_id) OR x"
