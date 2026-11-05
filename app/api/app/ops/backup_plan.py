"""v2 database backup naming + retention (ARC-15; port of v1 lib/backup/retention.ts, OPS-03).

Backups live in the dedicated R2 backup bucket as
``db-v2/ricotdin-v2-db-<yyyyMMdd>T<HHmm>Z.dump.age``
(UTC, minute precision; a ``pg_dump -Fc`` file, age-encrypted). The prefix differs from v1's
``db/ricotdin-db-…`` so neither prune ever touches the other's backups. Prune deletes backups
strictly older than the retention window, never the newest one and never a key that is not a
backup. Pure.
"""

import re
from collections.abc import Iterable
from datetime import UTC, datetime

BACKUP_PREFIX = "db-v2/"
_KEY = re.compile(r"db-v2/ricotdin-v2-db-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z\.dump\.age")
_DAY_S = 24 * 3600


def backup_object_key(when: datetime) -> str:
    stamp = when.astimezone(UTC).strftime("%Y%m%dT%H%MZ")
    return f"{BACKUP_PREFIX}ricotdin-v2-db-{stamp}.dump.age"


def parse_backup_timestamp(key: str) -> float | None:
    """Epoch seconds encoded in a backup key, or None when the key is not a (valid) backup."""
    m = _KEY.fullmatch(key)
    if not m:
        return None
    try:
        y, mo, d, h, mi = (int(g) for g in m.groups())
        return datetime(y, mo, d, h, mi, tzinfo=UTC).timestamp()
    except ValueError:  # month 13, Feb 31, 25:61
        return None


def select_expired_backups(keys: Iterable[str], now: float, retention_days: int) -> list[str]:
    """Keys to delete: backups strictly older than ``retention_days``, never the newest."""
    if type(retention_days) is not int or retention_days < 1:
        return []
    backups = [(k, ts) for k in keys if (ts := parse_backup_timestamp(k)) is not None]
    if not backups:
        return []
    newest = max(backups, key=lambda b: b[1])[0]
    cutoff = now - retention_days * _DAY_S
    return [k for k, ts in backups if k != newest and ts < cutoff]
