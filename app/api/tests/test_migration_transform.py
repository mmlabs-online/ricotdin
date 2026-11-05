"""ARC-03 pure logic: auth.users → users, row projection, load order, SQL builders, digests,
report. No I/O."""

import json

import pytest

from app.migration.checksum import RowDigest
from app.migration.plan import load_order, select_sql, upsert_sql
from app.migration.report import Report, StorageResult, TableResult
from app.migration.transform import (
    MigrationBlocked,
    map_auth_user,
    map_row,
    source_user_problems,
)

NOW = "2026-10-29 03:00:00+00"
UID = "11111111-1111-1111-1111-111111111111"


def _user(**over: object) -> dict[str, object]:
    row: dict[str, object] = {
        "id": UID,
        "email": "A@Example.com",
        "encrypted_password": "$2a$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz012",
        "email_confirmed_at": "2026-01-02 03:04:05.123456+00",
        "banned": False,
        "last_sign_in_at": "2026-10-01 00:00:00+00",
        "created_at": "2026-01-01 00:00:00+00",
        "updated_at": "2026-01-03 00:00:00+00",
        "raw_app_meta_data": json.dumps({"provider": "email", "role": "admin"}),
        "is_anonymous": False,
        "deleted_at": None,
    }
    row.update(over)
    return row


# --- map_auth_user ---------------------------------------------------------------------------


def test_user_keeps_id_email_and_bcrypt_hash() -> None:
    out = map_auth_user(_user(), now=NOW)
    assert out["id"] == UID
    assert out["email"] == "A@Example.com"  # unchanged: users has a lower(email) unique index
    assert str(out["password_hash"]).startswith("$2a$10$")
    assert out["email_verified_at"] == "2026-01-02 03:04:05.123456+00"
    assert out["last_sign_in_at"] == "2026-10-01 00:00:00+00"
    assert out["created_at"] == "2026-01-01 00:00:00+00"
    assert out["updated_at"] == "2026-01-03 00:00:00+00"
    assert out["disabled_at"] is None


@pytest.mark.parametrize(
    ("meta", "role"),
    [
        (json.dumps({"role": "admin"}), "admin"),
        (json.dumps({"role": "user"}), "user"),
        (json.dumps({"role": "superuser"}), "user"),
        (json.dumps({"role": ["admin"]}), "user"),
        (json.dumps({}), "user"),
        ("not json", "user"),
        (None, "user"),
        (json.dumps(["admin"]), "user"),
    ],
)
def test_role_comes_only_from_app_metadata_and_fails_closed(meta: object, role: str) -> None:
    assert map_auth_user(_user(raw_app_meta_data=meta), now=NOW)["role"] == role


def test_active_ban_becomes_disabled_at_snapshot_time() -> None:
    assert map_auth_user(_user(banned=True), now=NOW)["disabled_at"] == NOW
    assert map_auth_user(_user(banned=None), now=NOW)["disabled_at"] is None


def test_soft_deleted_user_is_disabled_at_deletion_time() -> None:
    out = map_auth_user(_user(deleted_at="2026-05-05 00:00:00+00"), now=NOW)
    assert out["disabled_at"] == "2026-05-05 00:00:00+00"


def test_missing_password_and_timestamps_get_safe_values() -> None:
    out = map_auth_user(_user(encrypted_password=None, created_at=None, updated_at=None), now=NOW)
    assert out["password_hash"] == ""  # no scheme: login fails until a password reset
    assert out["created_at"] == NOW
    assert out["updated_at"] == NOW


def test_anonymous_or_emailless_users_block_the_migration() -> None:
    with pytest.raises(MigrationBlocked, match="anonymous"):
        map_auth_user(_user(is_anonymous=True), now=NOW)
    for email in (None, "", "   "):
        with pytest.raises(MigrationBlocked, match="email"):
            map_auth_user(_user(email=email), now=NOW)


def test_source_user_problems_lists_blockers_by_id_only() -> None:
    rows = [
        _user(),
        _user(id="22222222-2222-2222-2222-222222222222", is_anonymous=True),
        _user(id="33333333-3333-3333-3333-333333333333", email=None),
        _user(id="44444444-4444-4444-4444-444444444444", email="a@example.COM"),
    ]
    problems = source_user_problems(rows)
    text = "\n".join(problems)
    assert "1 anonymous" in text and "22222222" in text
    assert "1 without email" in text and "33333333" in text
    assert "duplicate email" in text and "44444444" in text and UID in text
    assert "example" not in text.lower()  # never the address itself
    assert source_user_problems([_user()]) == []


# --- map_row ---------------------------------------------------------------------------------


def test_map_row_projects_to_target_columns_in_order() -> None:
    row = {"b": "2", "a": "1", "extra": "x"}
    assert map_row("t", row, ["a", "b"]) == ["1", "2"]


def test_map_row_refuses_a_missing_column() -> None:
    with pytest.raises(MigrationBlocked, match=r"t\.c"):
        map_row("t", {"a": "1"}, ["a", "c"])


# --- plan ------------------------------------------------------------------------------------


def test_load_order_puts_parents_first_and_is_deterministic() -> None:
    tables = {"users", "meetings", "folders", "todos", "transcript_segments", "app_config"}
    fks = [
        ("meetings", "users"),
        ("meetings", "folders"),
        ("folders", "users"),
        ("todos", "meetings"),
        ("todos", "transcript_segments"),
        ("transcript_segments", "meetings"),
        ("app_config", "users"),
        ("meetings", "meetings"),  # self reference ignored
        ("todos", "elsewhere"),  # outside the set ignored
    ]
    order = load_order(tables, fks)
    assert order == load_order(tables, list(reversed(fks)))
    assert order[0] == "users"
    for child, parent in fks:
        if child != parent and parent in tables:
            assert order.index(parent) < order.index(child)


def test_load_order_refuses_a_cycle() -> None:
    with pytest.raises(MigrationBlocked, match="cycle"):
        load_order({"a", "b"}, [("a", "b"), ("b", "a")])


def test_select_sql_casts_every_column_to_text() -> None:
    sql = select_sql("transcript_chunks", ["id", "embedding"])
    assert sql == 'SELECT "id"::text, "embedding"::text FROM public."transcript_chunks"'


def test_upsert_sql_casts_from_text_and_updates_non_key_columns() -> None:
    sql = upsert_sql(
        "todos", ["id", "title", "due"], ["uuid", "text", "timestamp with time zone"], ["id"]
    )
    assert sql == (
        'INSERT INTO public."todos" AS t ("id", "title", "due") VALUES '
        "(%s::text::uuid, %s::text::text, %s::text::timestamp with time zone) "
        'ON CONFLICT ("id") DO UPDATE SET "title" = EXCLUDED."title", "due" = EXCLUDED."due"'
    )


def test_upsert_sql_for_a_table_that_is_only_key_does_nothing_on_conflict() -> None:
    sql = upsert_sql("k", ["id"], ["uuid"], ["id"])
    assert sql.endswith('ON CONFLICT ("id") DO NOTHING')


def test_meetings_upsert_never_moves_audio_copied_to_drive_back_to_v1() -> None:
    sql = upsert_sql(
        "meetings",
        ["id", "audio_path", "storage_provider"],
        ["uuid", "text", "text"],
        ["id"],
    )
    assert (
        '"storage_provider" = CASE WHEN t."storage_provider" = \'gdrive\' AND '
        't."audio_path" IS NOT DISTINCT FROM EXCLUDED."audio_path" THEN \'gdrive\' '
        'ELSE EXCLUDED."storage_provider" END'
    ) in sql


def test_identifiers_are_validated() -> None:
    with pytest.raises(MigrationBlocked):
        select_sql('x"; DROP TABLE users; --', ["id"])
    with pytest.raises(MigrationBlocked):
        upsert_sql("t", ["id"], ["uuid); DROP TABLE users; --"], ["id"])


# --- checksum --------------------------------------------------------------------------------


def test_digest_is_order_independent_but_content_sensitive() -> None:
    a, b = RowDigest(), RowDigest()
    rows: list[list[str | None]] = [["1", "x", None], ["2", "y", ""]]
    for r in rows:
        a.add(r)
    for r in reversed(rows):
        b.add(r)
    assert a.hexdigest() == b.hexdigest() and a.count == b.count == 2

    c = RowDigest()
    c.add(["1", "x", ""])  # NULL and '' differ
    c.add(["2", "y", ""])
    assert c.hexdigest() != a.hexdigest()

    d = RowDigest()
    d.add(["1", "x", None])
    d.add(["1", "x", None])  # duplicates count
    assert d.hexdigest() != RowDigest().hexdigest()
    e = RowDigest()
    e.add(["1", "x", None])
    assert d.hexdigest() != e.hexdigest()


def test_digest_does_not_confuse_column_boundaries() -> None:
    a, b = RowDigest(), RowDigest()
    a.add(["ab", "c"])
    b.add(["a", "bc"])
    assert a.hexdigest() != b.hexdigest()


# --- report ----------------------------------------------------------------------------------


def _report(**over: object) -> Report:
    r = Report(
        started_at=NOW,
        source_host="aws-0-x.pooler.supabase.com",
        target_host="ep-x.neon.tech",
        tables=[TableResult("users", 2, 2, "aa", "aa"), TableResult("meetings", 1, 1, "bb", "bb")],
        embeddings_source=5,
        embeddings_target=5,
        secrets_ok=["admin_config 1"],
        secrets_failed=[],
        storage=StorageResult(),
    )
    for k, v in over.items():
        setattr(r, k, v)
    return r


def test_report_passes_only_when_everything_matches() -> None:
    assert _report().passed
    assert not _report(tables=[TableResult("users", 2, 1, "aa", "ab")]).passed
    assert not _report(tables=[TableResult("users", 2, 2, "aa", "ab")]).passed
    assert not _report(embeddings_target=4).passed
    assert not _report(secrets_failed=["storage_config 9"]).passed
    assert not _report(storage=StorageResult(failed=["k: timeout"])).passed
    assert not _report(blocked=["1 anonymous user"]).passed
    assert not _report(errors=["users: UniqueViolation 23505"]).passed
    assert not _report(source_only_tables=["provider_keys"]).passed
    assert not _report(storage=StorageResult(skipped=True)).passed
    assert not _report(dry_run=True).passed
    # Missing at source and forged keys are reported, not a failure (spec).
    assert _report(storage=StorageResult(missing_at_source=["u/m.webm"])).passed
    assert _report(storage=StorageResult(rejected=["evil/k.webm: not its row's key"])).passed


def test_report_renders_markdown_with_verdict() -> None:
    text = _report(
        storage=StorageResult(
            copied=["u/m.webm"],
            missing_at_source=["u/x.webm"],
            rejected=["evil/k.webm: not its row's key"],
            drive_folder="folder123",
            digest="ab" * 32,
            mapped=1,
        )
    ).render()
    assert "| users | 2 | 2 | ✅ |" in text
    assert "u/x.webm" in text and "evil/k.webm" in text
    assert "Drive folder: `folder123`" in text
    assert "`" + "ab" * 32 + "`" in text
    assert text.rstrip().endswith("**Result: PASS**")
    bad = _report(tables=[TableResult("users", 2, 1, "aa", "ab")]).render()
    assert "| users | 2 | 1 | ❌ |" in bad
    assert bad.rstrip().endswith("**Result: FAIL**")


def test_column_drift_reports_names_and_types_ignoring_schema_prefix() -> None:
    from app.migration.plan import column_drift

    src = {"id": "uuid", "embedding": "extensions.vector(768)", "old": "text", "n": "integer"}
    tgt = {"id": "uuid", "embedding": "vector(768)", "new": "text", "n": "bigint"}
    assert column_drift("t", src, tgt) == [
        "t.new: missing in source",
        "t.old: missing in target",
        "t.n: integer in source, bigint in target",
    ]
    assert column_drift("t", {"a": "text"}, {"a": "text"}) == []


def test_r2_source_is_read_only_and_maps_every_boto_failure_to_a_code_only_error(
    tmp_path: object,
) -> None:
    from pathlib import Path

    from botocore.exceptions import ClientError, EndpointConnectionError

    from app.services.storage.config import R2Config
    from scripts.migrate_from_supabase import CopyError, R2Source

    calls: list[str] = []

    class Body:
        def __init__(self, data: bytes) -> None:
            self.data = data

        def read(self, n: int) -> bytes:
            out, self.data = self.data[:n], self.data[n:]
            return out

        def close(self) -> None:
            pass

    class Client:
        def __init__(self, exc: Exception | None = None, data: bytes = b"abc") -> None:
            self.exc, self.data = exc, data

        def __getattr__(self, name: str) -> object:
            def call(**_k: object) -> object:
                calls.append(name)
                if self.exc:
                    raise self.exc
                if name == "head_object":
                    return {"ContentLength": 3, "ETag": '"' + "a" * 32 + '"'}
                return {"Body": Body(self.data)}

            return call

    s = R2Source(R2Config("0123456789abcdef0123456789abcdef", "AKID", "secret", "bucket"))
    path = Path(str(tmp_path)) / "f"
    s._client = Client()  # type: ignore[assignment]
    head = s.head("k")
    assert head is not None and (head.size, head.md5) == (3, "a" * 32)
    s.download("k", path, 10)
    assert path.read_bytes() == b"abc"
    with pytest.raises(CopyError, match="larger than the limit"):
        s.download("k", path, 2)
    missing = ClientError({"Error": {"Code": "404", "Message": "bucket/k gone"}}, "HeadObject")
    s._client = Client(missing)  # type: ignore[assignment]
    assert s.head("k") is None
    for exc, reason in (
        (EndpointConnectionError(endpoint_url="https://x"), "EndpointConnectionError"),
        (
            ClientError({"Error": {"Code": "AccessDenied", "Message": "secret"}}, "Get"),
            "AccessDenied",
        ),
    ):
        s._client = Client(exc)  # type: ignore[assignment]
        with pytest.raises(CopyError) as info:
            s.download("k", path, 10)
        assert str(info.value) == f"r2 download {reason}"
        with pytest.raises(CopyError) as info:
            s.head("k")
        assert str(info.value) == f"r2 head {reason}"
    assert set(calls) == {"head_object", "get_object"}  # never a write or a delete


def test_supabase_download_refuses_redirects() -> None:
    import urllib.request

    from scripts.migrate_from_supabase import SupabaseStorage, _NoRedirect

    store = SupabaseStorage("https://ref.supabase.co", "service-key")
    handlers = [
        h
        for h in store._opener.handlers  # type: ignore[attr-defined]
        if isinstance(h, urllib.request.HTTPRedirectHandler)
    ]
    assert handlers and all(isinstance(h, _NoRedirect) for h in handlers)
    assert handlers[0].redirect_request(None, None, 302, "", {}, "https://x") is None  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        SupabaseStorage("http://ref.supabase.co", "k")


def test_bug019_report_prints_on_a_cp1252_console() -> None:
    """BUG-019: printing the report must not raise on a Windows console (cp1252, strict)."""
    import io

    from scripts.migrate_from_supabase import emit_report

    raw = io.BytesIO()
    console = io.TextIOWrapper(raw, encoding="cp1252", errors="strict")
    text = Report(started_at="t", source_host="a", target_host="b").render()
    assert "→" in text
    emit_report(text, console)
    console.flush()
    out = raw.getvalue().decode("cp1252")
    assert "Result:" in out
    assert "- Source: `a` ? target: `b`" in out  # → replaced, the rest intact
    emit_report(text, None)  # no console at all: silently nothing


def test_bug019_report_keeps_unicode_on_a_utf8_console() -> None:
    import io

    from scripts.migrate_from_supabase import emit_report

    raw = io.BytesIO()
    console = io.TextIOWrapper(raw, encoding="utf-8", errors="strict", newline="\n")
    emit_report("source → target ✅", console)
    console.flush()
    assert raw.getvalue().decode("utf-8") == "source → target ✅\n"


def test_bug020_every_table_created_after_the_baseline_is_v2_only() -> None:
    # Tables created by v2-only migrations (0002+) do not exist in Supabase; the preflight must
    # skip them, or every run is blocked ("source has no table public.drive_config").
    import re

    from scripts.migrate_from_supabase import API_ROOT, NOT_COPIED_TABLES, V2_ONLY_TABLES

    created: set[str] = set()
    for sql in sorted((API_ROOT / "migrations" / "sql").glob("*.sql")):
        if sql.name.startswith("0001_") or sql.name.endswith("_down.sql"):
            continue
        created |= set(
            re.findall(r"CREATE TABLE (?:IF NOT EXISTS )?public\.(\w+)", sql.read_text("utf-8"))
        )
    assert {"drive_config", "storage_objects"} <= created
    assert created <= V2_ONLY_TABLES
    assert created <= NOT_COPIED_TABLES  # never copied from Supabase either


def test_duplicate_active_jobs_block_the_run() -> None:
    # ARC-08 migration 0005: one queued/running job per meeting. The copy would abort mid-way on
    # the unique index, so the preflight blocks first and says how to fix v1 (review round 1).
    from app.migration.plan import DUPLICATE_ACTIVE_JOBS_SQL, duplicate_active_jobs_problem

    assert duplicate_active_jobs_problem(0) is None
    problem = duplicate_active_jobs_problem(3)
    assert problem is not None
    assert problem.startswith("3 meeting(s) have more than one queued/running job in v1")
    assert "UPDATE public.jobs" in problem and "newest" in problem
    assert "GROUP BY meeting_id" in DUPLICATE_ACTIVE_JOBS_SQL
