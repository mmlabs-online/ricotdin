"""ARC-02: rewriting SQL taken from the replayed v1 (Supabase) catalog into v2 SQL."""

import pytest

from app.db.v1_rewrite import UnsupportedV1Reference, map_role, rewrite_v1_sql


def test_foreign_key_to_auth_users_points_at_public_users() -> None:
    v1 = "FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE"
    assert (
        rewrite_v1_sql(v1) == "FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE"
    )


def test_policy_expression_as_printed_by_pg_policies() -> None:
    v1 = "((auth.uid() = user_id) OR ((auth.jwt() ->> 'user_role'::text) = 'admin'::text))"
    assert rewrite_v1_sql(v1) == (
        "((public.app_user_id() = user_id) OR (public.app_user_role() = 'admin'::text))"
    )


def test_function_body_source_text() -> None:
    v1 = "WHERE m.user_id = auth.uid() OR auth.jwt()->>'user_role' = 'admin'"
    assert rewrite_v1_sql(v1) == (
        "WHERE m.user_id = public.app_user_id() OR public.app_user_role() = 'admin'"
    )


def test_auth_inside_a_string_literal_is_data_not_a_reference() -> None:
    v1 = "INSERT INTO app_config (key) VALUES ('auth.require_email_verification')"
    assert rewrite_v1_sql(v1) == v1


def test_any_other_auth_reference_fails_loudly() -> None:
    with pytest.raises(UnsupportedV1Reference, match=r"auth\.sessions"):
        rewrite_v1_sql("SELECT 1 FROM auth.sessions")


def test_reading_supabase_request_jwt_settings_fails_even_inside_a_literal() -> None:
    # prevent_role_escalation() reads the claims via current_setting(); without this check
    # the v2 trigger would silently allow every role change.
    with pytest.raises(UnsupportedV1Reference, match=r"request\.jwt"):
        rewrite_v1_sql("jwt_claims := current_setting('request.jwt.claims', true);")


def test_jwt_claims_other_than_user_role_are_unsupported() -> None:
    with pytest.raises(UnsupportedV1Reference):
        rewrite_v1_sql("auth.jwt() ->> 'email'")


@pytest.mark.parametrize(
    ("v1", "v2"),
    [
        ("authenticated", "ricotdin_app"),
        ("service_role", "ricotdin_service"),
        ("anon", None),
        ("supabase_auth_admin", None),
        ("PUBLIC", "PUBLIC"),
        ("postgres", None),
    ],
)
def test_map_role(v1: str, v2: str | None) -> None:
    assert map_role(v1) == v2
