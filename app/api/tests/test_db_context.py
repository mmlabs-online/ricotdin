"""ARC-04 (R3–R5): the per-transaction RLS context statements. Pure."""

import uuid

import pytest

from app.db.context import InvalidRequestContext, RequestIdentity, rls_context_statements


def test_statements_set_role_then_transaction_local_settings_with_bind_params() -> None:
    uid = uuid.uuid4()
    stmts = rls_context_statements(RequestIdentity(user_id=uid, role="admin"))
    assert stmts == [
        ("SET LOCAL ROLE ricotdin_app", {}),
        ("SELECT set_config('app.user_id', :user_id, true)", {"user_id": str(uid)}),
        ("SELECT set_config('app.role', :role, true)", {"role": "admin"}),
    ]


def test_no_statement_interpolates_a_value() -> None:
    uid = uuid.uuid4()
    for sql, _ in rls_context_statements(RequestIdentity(user_id=uid, role="user")):
        assert str(uid) not in sql
        assert "'user'" not in sql


@pytest.mark.parametrize("role", ["", "superuser", "Admin", "admin ", "user;DROP"])
def test_only_user_or_admin_roles(role: str) -> None:
    with pytest.raises(InvalidRequestContext):
        rls_context_statements(RequestIdentity(user_id=uuid.uuid4(), role=role))


def test_user_id_must_be_a_uuid() -> None:
    with pytest.raises(InvalidRequestContext):
        rls_context_statements(RequestIdentity(user_id="not-a-uuid", role="user"))  # type: ignore[arg-type]
