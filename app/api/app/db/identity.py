"""Startup check of a database login's power (ARC-04, CLAUDE.md §0.1 R1/R2). Pure.

The facts are read from the catalog at startup (``app.db.session``); any problem stops the API:
running requests as the owner, a superuser or a BYPASSRLS role would switch RLS off, and a login
in two runtime groups could ``SET ROLE`` its way out of its job.
"""

from dataclasses import dataclass, field

RUNTIME_GROUPS = ("ricotdin_app", "ricotdin_service", "ricotdin_worker")


@dataclass(frozen=True)
class LoginFacts:
    login: str
    expected_group: str
    member_of: set[str] = field(default_factory=set)  # runtime groups the login belongs to
    is_superuser: bool = False
    bypasses_rls: bool = False
    inherits: bool = True
    owns_public_tables: bool = False


def identity_problems(f: LoginFacts) -> list[str]:
    problems: list[str] = []
    if f.is_superuser:
        problems.append(f"{f.login} is a superuser")
    if f.bypasses_rls:
        problems.append(f"{f.login} has BYPASSRLS")
    if f.owns_public_tables:
        problems.append(f"{f.login} owns tables in public (the owner bypasses RLS)")
    if f.expected_group not in f.member_of:
        problems.append(f"{f.login} is not a member of {f.expected_group}")
    for other in sorted(set(f.member_of) - {f.expected_group}):
        if other in RUNTIME_GROUPS:
            problems.append(f"{f.login} is also a member of {other}")
    if f.inherits:
        problems.append(
            f"{f.login} must be NOINHERIT (privileges only after SET ROLE {f.expected_group})"
        )
    return problems
