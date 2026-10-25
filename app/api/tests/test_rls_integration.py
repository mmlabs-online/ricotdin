"""ARC-02: RLS and privileges on the v2 schema behave like v1 (CLAUDE.md §6, §9b, migrations
012/025/033–038), now driven by app.user_id / app.role instead of the Supabase JWT.

Data is seeded as the table owner (bypasses RLS). Each check runs in its own transaction as
``ricotdin_app`` or ``ricotdin_service`` with the request context set via ``set_config``.
"""

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import psycopg
import pytest
from psycopg import sql

from tests.conftest import requires_db

pytestmark = requires_db

A, B, ADMIN, VIEWER, EDITOR = (uuid.uuid4() for _ in range(5))
FOLDER, MEETING_A, MEETING_B = (uuid.uuid4() for _ in range(3))


@pytest.fixture(scope="module")
def db(v2_db: str) -> str:
    with psycopg.connect(v2_db, autocommit=True) as conn:
        conn.execute("GRANT ricotdin_app, ricotdin_service TO CURRENT_USER")
        for uid, name, role in [
            (A, "user_a", "user"),
            (B, "user_b", "user"),
            (ADMIN, "admin_1", "admin"),
            (VIEWER, "viewer_1", "user"),
            (EDITOR, "editor_1", "user"),
        ]:
            conn.execute(
                "INSERT INTO users (id, email, password_hash, role) VALUES (%s, %s, 'x', %s)",
                (uid, f"{name}@example.test", role),
            )
            conn.execute(
                "INSERT INTO profiles (id, username, role) VALUES (%s, %s, %s)", (uid, name, role)
            )
        conn.execute(
            "INSERT INTO folders (id, user_id, name) VALUES (%s, %s, 'shared')", (FOLDER, B)
        )
        conn.execute(
            "INSERT INTO meetings (id, user_id, title) VALUES (%s, %s, 'a')", (MEETING_A, A)
        )
        conn.execute(
            "INSERT INTO meetings (id, user_id, title, folder_id) VALUES (%s, %s, 'b', %s)",
            (MEETING_B, B, FOLDER),
        )
        conn.execute(
            "INSERT INTO folder_shares (folder_id, user_id, role) VALUES (%s, %s, 'viewer'), (%s, %s, 'editor')",
            (FOLDER, VIEWER, FOLDER, EDITOR),
        )
        conn.execute("INSERT INTO todos (meeting_id, content) VALUES (%s, 'todo b')", (MEETING_B,))
        vec = "[" + ",".join(["0.1"] * 768) + "]"
        conn.execute(
            "INSERT INTO transcript_chunks (meeting_id, chunk_index, content, embedding) "
            "VALUES (%s, 0, 'chunk b', %s::vector)",
            (MEETING_B, vec),
        )
    return v2_db


@contextmanager
def as_role(
    url: str, role: str, user: uuid.UUID | None = None, app_role: str = "user"
) -> Iterator[psycopg.Connection[Any]]:
    """A transaction as ``role`` with the request context set; always rolled back."""
    with psycopg.connect(url) as conn:
        conn.execute(f"SET LOCAL ROLE {role}")
        if user is not None:
            conn.execute("SELECT set_config('app.user_id', %s, true)", (str(user),))
            conn.execute("SELECT set_config('app.role', %s, true)", (app_role,))
        try:
            yield conn
        finally:
            conn.rollback()


def _ids(conn: psycopg.Connection[Any], query: str) -> set[uuid.UUID]:
    return {r[0] for r in conn.execute(query)}


def test_owner_sees_only_own_meetings(db: str) -> None:
    with as_role(db, "ricotdin_app", A) as conn:
        assert _ids(conn, "SELECT id FROM meetings") == {MEETING_A}


def test_no_request_context_sees_nothing(db: str) -> None:
    with as_role(db, "ricotdin_app") as conn:
        assert _ids(conn, "SELECT id FROM meetings") == set()


def test_admin_has_no_content_bypass(db: str) -> None:
    # migration 025: admins manage accounts, not other users' meeting content.
    with as_role(db, "ricotdin_app", ADMIN, "admin") as conn:
        assert _ids(conn, "SELECT id FROM meetings") == set()


def test_admin_reads_all_profiles(db: str) -> None:
    with as_role(db, "ricotdin_app", ADMIN, "admin") as conn:
        assert len(_ids(conn, "SELECT id FROM profiles")) == 5
    with as_role(db, "ricotdin_app", A) as conn:
        assert _ids(conn, "SELECT id FROM profiles") == {A}


def test_shared_folder_viewer_reads_meeting_todos_and_chunks(db: str) -> None:
    with as_role(db, "ricotdin_app", VIEWER) as conn:
        assert _ids(conn, "SELECT id FROM meetings") == {MEETING_B}
        assert len(_ids(conn, "SELECT id FROM todos")) == 1
        assert len(_ids(conn, "SELECT id FROM transcript_chunks")) == 1


def test_stranger_reads_none_of_the_shared_folder(db: str) -> None:
    with as_role(db, "ricotdin_app", A) as conn:
        assert _ids(conn, "SELECT id FROM todos") == set()
        assert _ids(conn, "SELECT id FROM transcript_chunks") == set()


@pytest.mark.parametrize(
    "statement",
    [
        "INSERT INTO meetings (user_id, title) VALUES (app_user_id(), 'x')",  # BUG-003
        "UPDATE meetings SET title = 'x'",  # BUG-003
        "DELETE FROM meetings",  # BUG-008
        "UPDATE todos SET content = 'x'",  # BUG-009
        "DELETE FROM transcript_segments",  # BUG-007
        "INSERT INTO chat_sessions (user_id) VALUES (app_user_id())",  # BUG-010
    ],
)
def test_app_role_cannot_write_server_owned_tables(db: str, statement: str) -> None:
    with (
        as_role(db, "ricotdin_app", B) as conn,
        pytest.raises(psycopg.errors.InsufficientPrivilege),
    ):
        conn.execute(statement)


@pytest.mark.parametrize(
    "table", ["users", "refresh_tokens", "email_tokens", "admin_config", "storage_config"]
)
def test_app_role_cannot_read_secret_tables(db: str, table: str) -> None:
    with (
        as_role(db, "ricotdin_app", ADMIN, "admin") as conn,
        pytest.raises(psycopg.errors.InsufficientPrivilege),
    ):
        conn.execute(sql.SQL("SELECT 1 FROM {}").format(sql.Identifier(table)))


@pytest.mark.parametrize("function", ["claim_next_job", "quota_apply_movement"])
def test_definer_rpcs_are_service_only(db: str, function: str) -> None:
    # BUG-005 / migration 034.
    with psycopg.connect(db) as conn:
        row = conn.execute(
            """SELECT bool_and(has_function_privilege('ricotdin_app', oid, 'EXECUTE')),
                      bool_and(has_function_privilege('ricotdin_service', oid, 'EXECUTE'))
               FROM pg_proc WHERE proname = %s""",
            (function,),
        ).fetchone()
    assert row == (False, True)


def test_service_role_sees_everything_without_context(db: str) -> None:
    with as_role(db, "ricotdin_service") as conn:
        assert _ids(conn, "SELECT id FROM meetings") == {MEETING_A, MEETING_B}
        assert len(_ids(conn, "SELECT id FROM users")) == 5


def test_role_change_needs_admin_context_and_syncs_to_profiles(db: str) -> None:
    # prevent_role_escalation (v2 override): a non-admin request context cannot change roles.
    with psycopg.connect(db) as conn:
        conn.execute("SELECT set_config('app.user_id', %s, true)", (str(A),))
        conn.execute("SELECT set_config('app.role', 'user', true)")
        with pytest.raises(psycopg.errors.RaiseException, match="Only admins"):
            conn.execute("UPDATE profiles SET role = 'admin' WHERE id = %s", (A,))
        conn.rollback()
    # No request context (service) may; users.role → profiles.role is mirrored by trigger.
    with psycopg.connect(db) as conn:
        conn.execute("UPDATE users SET role = 'admin' WHERE id = %s", (B,))
        row = conn.execute("SELECT role FROM profiles WHERE id = %s", (B,)).fetchone()
        assert row == ("admin",)
        conn.rollback()
