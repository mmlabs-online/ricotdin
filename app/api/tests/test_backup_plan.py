"""ARC-15 Neon backup naming + retention (port of v1 lib/backup/retention.ts, OPS-03)."""

from datetime import UTC, datetime

from app.ops.backup_plan import (
    BACKUP_PREFIX,
    backup_object_key,
    parse_backup_timestamp,
    select_expired_backups,
)

DAY = 24 * 3600


def _key(y: int, mo: int, d: int, h: int = 2, mi: int = 0) -> str:
    return backup_object_key(datetime(y, mo, d, h, mi, tzinfo=UTC))


def test_key_is_utc_minute_precision_under_its_own_prefix() -> None:
    assert backup_object_key(datetime(2026, 11, 5, 2, 7, 59, tzinfo=UTC)) == (
        "db-v2/ricotdin-v2-db-20261105T0207Z.dump.age"
    )
    assert BACKUP_PREFIX == "db-v2/"
    # v1's prune only deletes db/ricotdin-db-…: the v2 keys never match its pattern
    assert not _key(2026, 1, 1).startswith("db/")


def test_parse_round_trips_and_rejects_anything_else() -> None:
    key = _key(2026, 11, 5, 2, 7)
    assert parse_backup_timestamp(key) == datetime(2026, 11, 5, 2, 7, tzinfo=UTC).timestamp()
    for bad in (
        "db-v2/ricotdin-v2-db-20261305T0207Z.dump.age",  # month 13
        "db-v2/ricotdin-v2-db-20260231T0207Z.dump.age",  # Feb 31
        "db-v2/ricotdin-v2-db-20261105T2561Z.dump.age",  # 25:61
        "db-v2/ricotdin-v2-db-20261105T0207Z.dump",  # not encrypted
        "db/ricotdin-db-20261105T0207Z.tar.gz.age",  # a v1 backup
        "db-v2/other.age",
        "",
    ):
        assert parse_backup_timestamp(bad) is None, bad


def test_expired_are_strictly_older_than_the_window_never_the_newest() -> None:
    now = datetime(2026, 11, 30, 3, 0, tzinfo=UTC).timestamp()
    keys = [_key(2026, 10, 30, 2, 59), _key(2026, 10, 31, 3, 0), _key(2026, 11, 29), "db-v2/x"]
    assert select_expired_backups(keys, now, 30) == [_key(2026, 10, 30, 2, 59)]
    # only old backups left: the newest one always stays
    old = [_key(2026, 1, 1), _key(2026, 1, 2)]
    assert select_expired_backups(old, now, 30) == [_key(2026, 1, 1)]
    assert select_expired_backups([], now, 30) == []


def test_bad_retention_deletes_nothing() -> None:
    now = datetime(2026, 11, 30, tzinfo=UTC).timestamp()
    keys = [_key(2020, 1, 1), _key(2026, 11, 29)]
    for days in (0, -1, 1.5, None, "30"):
        assert select_expired_backups(keys, now, days) == []  # type: ignore[arg-type]
    assert select_expired_backups(keys, now, 1) == [_key(2020, 1, 1)]
    assert DAY == 86400
