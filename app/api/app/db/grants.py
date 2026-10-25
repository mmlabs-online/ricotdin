"""Which v1 `authenticated` table privileges ricotdin_app keeps in v2 (ARC-02 review). Pure.

v1 reached tables only through PostgREST, so Supabase's default ``GRANT ALL`` to `authenticated`
never mattered beyond the REST verbs. v2 runs SQL as ricotdin_app, so:

* TRUNCATE, TRIGGER, REFERENCES and MAINTAIN are dropped: RLS does not govern them (TRUNCATE
  ignores row security, TRIGGER/MAINTAIN allow CREATE TRIGGER / LOCK TABLE).
* INSERT / UPDATE / DELETE are kept only where a policy for that command (or ALL) applies to the
  app (v1 `authenticated` or `public`); without one RLS denies the command anyway.

Grants are given and returned with v1 grantee names; role mapping happens afterwards.
"""

from collections.abc import Sequence

from app.db.ddl import Policy

APP_GRANTEES = {"authenticated"}  # v1 name of ricotdin_app
_POLICY_ROLES_FOR_APP = {"authenticated", "public"}
_NOT_RLS_GOVERNED = {"TRUNCATE", "TRIGGER", "REFERENCES", "MAINTAIN"}
_DML = {"INSERT", "UPDATE", "DELETE"}

Grant = tuple[str, str, str | None]  # (grantee, privilege, column or None)


def _commands_allowed(table: str, policies: Sequence[Policy]) -> set[str]:
    allowed: set[str] = set()
    for p in policies:
        if p.table == table and _POLICY_ROLES_FOR_APP & set(p.roles):
            allowed |= _DML if p.cmd == "ALL" else {p.cmd}
    return allowed


def restrict_app_grants(
    table: str, grants: Sequence[Grant], policies: Sequence[Policy]
) -> list[Grant]:
    commands = _commands_allowed(table, policies)
    kept: list[Grant] = []
    for grantee, privilege, column in grants:
        if grantee in APP_GRANTEES:
            if privilege in _NOT_RLS_GOVERNED:
                continue
            if privilege in _DML and privilege not in commands:
                continue
        kept.append((grantee, privilege, column))
    return kept
