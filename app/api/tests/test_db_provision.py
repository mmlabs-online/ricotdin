"""ARC-04: runtime login URLs reuse the owner's host/database/options with their own credentials."""

from app.db.provision import GROUP_LOGINS, Login


def test_login_url_replaces_only_the_credentials_and_escapes_them() -> None:
    owner = "postgresql://neondb_owner:ownerpw@ep-x.aws.neon.tech/neondb?sslmode=require"
    url = Login("ricotdin_app", "ricotdin_api_login", "a/b@c:d").url(owner)
    assert url == (
        "postgresql://ricotdin_api_login:a%2Fb%40c%3Ad@ep-x.aws.neon.tech/neondb?sslmode=require"
    )
    assert "ownerpw" not in url


def test_each_runtime_group_has_its_own_login_and_env_key() -> None:
    names = [v[0] for v in GROUP_LOGINS.values()]
    keys = [v[1] for v in GROUP_LOGINS.values()]
    assert set(GROUP_LOGINS) == {"ricotdin_app", "ricotdin_service", "ricotdin_worker"}
    assert len(set(names)) == 3 and len(set(keys)) == 3
