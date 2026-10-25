"""Guards for destructive database operations (ARC-02 review). Pure."""

from collections.abc import Mapping

SCRATCH_PREFIX = "ricotdin_test_"
OPT_IN_ENV = "RICOTDIN_ALLOW_DESTRUCTIVE_DOWNGRADE"


class DestructiveOperationRefused(RuntimeError):
    """A destructive operation was aimed at a database that is not a scratch database."""


def is_scratch_name(dbname: str) -> bool:
    """True only for databases created by ``scratch_database`` (exact prefix, no wildcards)."""
    return dbname.startswith(SCRATCH_PREFIX)


def check_destructive_allowed(dbname: str, env: Mapping[str, str]) -> None:
    """Allow dropping everything only on scratch databases or with ``OPT_IN_ENV=1``."""
    if is_scratch_name(dbname) or env.get(OPT_IN_ENV) == "1":
        return
    raise DestructiveOperationRefused(
        f"refusing to drop schema public in database {dbname!r}: only {SCRATCH_PREFIX}* databases, "
        f"or set {OPT_IN_ENV}=1 if you really mean it"
    )
