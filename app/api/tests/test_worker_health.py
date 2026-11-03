"""ARC-08d: the worker container's heartbeat health check."""

from pathlib import Path

from app.worker.health import HEARTBEAT_MAX_AGE_S, beat, check, is_fresh


def test_is_fresh() -> None:
    assert is_fresh(1000.0, 1000.0 + HEARTBEAT_MAX_AGE_S)
    assert not is_fresh(1000.0, 1000.0 + HEARTBEAT_MAX_AGE_S + 1)
    assert not is_fresh(None, 1000.0)
    assert not is_fresh(2000.0, 1000.0)  # a clock far in the future is not "fresh"


def test_beat_then_check(tmp_path: Path) -> None:
    hb = tmp_path / "hb"
    assert not check(hb)
    beat(hb)
    assert check(hb)
    assert not check(hb, now=hb.stat().st_mtime + HEARTBEAT_MAX_AGE_S + 1)
