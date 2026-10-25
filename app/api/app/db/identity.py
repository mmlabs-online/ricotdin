"""Startup check of a database login's power (ARC-04, CLAUDE.md §0.1 R1/R2). Pure.

The facts come from the catalog at startup (``app.db.session``) and describe what the login can
*reach*, transitively: roles it may ``SET ROLE`` to and roles whose privileges it inherits (on
PG16+ inheritance is a per-grant option, so ``rolinherit`` alone proves nothing). Any problem
stops the API: running requests as the owner, a superuser, a BYPASSRLS or CREATEROLE role would
switch RLS off or let the login grant itself more.
"""

from dataclasses import dataclass, field

RUNTIME_GROUPS = ("ricotdin_app", "ricotdin_service", "ricotdin_worker")


@dataclass(frozen=True)
class LoginFacts:
    login: str
    expected_group: str
    settable_roles: set[str] = field(default_factory=set)  # pg_has_role(login, r, 'SET'), r ≠ login
    inherited_roles: set[str] = field(
        default_factory=set
    )  # pg_has_role(login, r, 'USAGE'), r ≠ login
    privileged_roles: set[str] = field(default_factory=set)  # settable roles that are privileged
    is_superuser: bool = False
    bypasses_rls: bool = False
    can_create_roles: bool = False
    owns_public_tables: bool = False


def identity_problems(f: LoginFacts) -> list[str]:
    problems: list[str] = []
    if f.is_superuser:
        problems.append(f"{f.login} is a superuser")
    if f.bypasses_rls:
        problems.append(f"{f.login} has BYPASSRLS")
    if f.can_create_roles:
        problems.append(f"{f.login} has CREATEROLE")
    if f.owns_public_tables:
        problems.append(f"{f.login} owns tables in public (the owner bypasses RLS)")
    if f.expected_group not in f.settable_roles:
        problems.append(f"{f.login} cannot SET ROLE {f.expected_group}")
    others = sorted(f.settable_roles - {f.expected_group})
    if others:
        problems.append(f"{f.login} can also SET ROLE to: {', '.join(others)}")
    if f.inherited_roles:
        problems.append(
            f"{f.login} inherits privileges of: {', '.join(sorted(f.inherited_roles))} "
            "(grant must be WITH INHERIT FALSE)"
        )
    if f.privileged_roles:
        problems.append(
            f"{f.login} can reach a privileged role (superuser/BYPASSRLS/CREATEROLE/owner): "
            f"{', '.join(sorted(f.privileged_roles))}"
        )
    return problems
