"""AUT-06: migration 0011 wipes ricotdin's own credentials (password hashes, refresh and email
tokens) without changing the schema (the tables go with ARC-16 part 2)."""

import uuid

import psycopg

from app.db.scratch import scratch_database
from tests.conftest import alembic_upgrade, requires_db

pytestmark = requires_db


def test_0011_wipes_legacy_credentials_and_keeps_users() -> None:
    with scratch_database("wipe") as url:
        alembic_upgrade(url, "0010_mmlabs_identity")
        uid = uuid.uuid4()
        with psycopg.connect(url, autocommit=True) as c:
            c.execute("INSERT INTO users (id, email, password_hash, role, email_verified_at) "
                      "VALUES (%s, 'old@example.test', '$argon2id$x', 'user', now())", (uid,))  # fmt: skip
            c.execute("INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) "
                      "VALUES (%s, gen_random_uuid(), 'h1', now() + interval '1 day')", (uid,))  # fmt: skip
            c.execute("INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at) "
                      "VALUES (%s, 'reset_password', 'h2', now() + interval '1 hour')", (uid,))  # fmt: skip
        alembic_upgrade(url, "head")
        with psycopg.connect(url, autocommit=True) as c:
            assert c.execute("SELECT email, password_hash FROM users WHERE id = %s",
                             (uid,)).fetchall() == [("old@example.test", None)]  # fmt: skip
            assert c.execute("SELECT count(*) FROM refresh_tokens").fetchone() == (0,)
            assert c.execute("SELECT count(*) FROM email_tokens").fetchone() == (0,)
