"""ARC-04: runtime login URLs, env-file editing and secret hygiene of the provisioning code."""

from app.db.provision import GROUP_LOGINS, Login, set_env_line


def test_login_url_replaces_only_the_credentials_and_escapes_them() -> None:
    owner = "postgresql://neondb_owner:ownerpw@ep-x.aws.neon.tech/neondb?sslmode=require"
    url = Login("ricotdin_app", "ricotdin_api_login", "a/b@c:d").url(owner)
    assert url == (
        "postgresql://ricotdin_api_login:a%2Fb%40c%3Ad@ep-x.aws.neon.tech/neondb?sslmode=require"
    )
    assert "ownerpw" not in url


def test_password_is_not_in_repr() -> None:
    login = Login("ricotdin_app", "ricotdin_api_login", "s3cr3t-password")
    assert "s3cr3t-password" not in repr(login)


def test_each_runtime_group_has_its_own_login_and_env_key() -> None:
    names = [v[0] for v in GROUP_LOGINS.values()]
    keys = [v[1] for v in GROUP_LOGINS.values()]
    assert set(GROUP_LOGINS) == {"ricotdin_app", "ricotdin_service", "ricotdin_worker"}
    assert len(set(names)) == 3 and len(set(keys)) == 3


def test_set_env_line_replaces_plain_export_and_spaced_forms() -> None:
    lines = [
        "DATABASE_URL=owner",
        "export DATABASE_URL_APP=old1",
        "DATABASE_URL_APP = old2",
        "# DATABASE_URL_APP=comment stays",
        "OTHER=x",
    ]
    assert set_env_line(lines, "DATABASE_URL_APP", "new") == [
        "DATABASE_URL=owner",
        "# DATABASE_URL_APP=comment stays",
        "OTHER=x",
        "DATABASE_URL_APP=new",
    ]


def test_set_env_line_does_not_touch_keys_with_the_same_prefix() -> None:
    assert set_env_line(["DATABASE_URL_APP_X=1"], "DATABASE_URL_APP", "v") == [
        "DATABASE_URL_APP_X=1",
        "DATABASE_URL_APP=v",
    ]
