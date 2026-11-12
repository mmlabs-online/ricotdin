"""ARC-08e pure scheduler/task helpers. Ports of v1 ``tests/retention.test.ts`` (setting parse,
cutoff, eligibility) and ``tests/key-healthcheck.test.ts`` (probe shape per provider, verdicts),
plus the task table and the v2 rule that a probe never puts a key in a URL."""

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.services.ai import catalog
from app.worker.schedule import LEASE_S, TASK_TIMEOUT_S, TASKS
from app.worker.tasks.keyhealth import (
    Verdict,
    classify_error,
    classify_status,
    probe_for,
    summarize,
)
from app.worker.tasks.retention import (
    MAX_RETENTION_DAYS,
    PURGE_BATCH_LIMIT,
    RETENTION_SETTING_KEY,
    is_purge_eligible,
    parse_retention_days,
    retention_cutoff,
)

# --- task table -----------------------------------------------------------------------------------


def test_tasks_and_intervals() -> None:
    assert TASKS == {
        "key_health": 24 * 3600, "retention_purge": 24 * 3600,
        "wallet_reconcile": 5 * 60, "stuck_meetings": 5 * 60,
    }  # fmt: skip
    assert TASK_TIMEOUT_S < LEASE_S  # a live run never loses its lease


# --- retention (v1 retention.test.ts) -------------------------------------------------------------


def test_retention_constants() -> None:
    assert RETENTION_SETTING_KEY == "storage.audio_retention_days"
    assert PURGE_BATCH_LIMIT == 500 and MAX_RETENTION_DAYS == 3650


@pytest.mark.parametrize(
    ("value", "days"),
    [(30, 30), (" 7 ", 7), ("365", 365), (1, 1), (3650, 3650),
     (None, None), (0, None), (-3, None), (1.5, None), (float("nan"), None), (float("inf"), None),
     (True, None), ("abc", None), ("1.0", None), ({}, None), ([30], None), (3651, None),
     ("99999", None)],
)  # fmt: skip
def test_parse_retention_days(value: Any, days: int | None) -> None:
    assert parse_retention_days(value) == days


def test_cutoff_is_exactly_n_days_before_now() -> None:
    now = datetime(2026, 11, 3, 12, tzinfo=UTC)
    assert retention_cutoff(now, 30) == now - timedelta(days=30)


def test_eligibility() -> None:
    cutoff = datetime(2026, 10, 1, tzinfo=UTC)
    before, at, after = cutoff - timedelta(seconds=1), cutoff, cutoff + timedelta(seconds=1)
    assert is_purge_eligible("done", "u/m.webm", before, cutoff)
    assert not is_purge_eligible("done", "u/m.webm", at, cutoff)  # strictly older only
    assert not is_purge_eligible("done", "u/m.webm", after, cutoff)
    for status in ("pending", "processing", "failed"):
        assert not is_purge_eligible(status, "u/m.webm", before, cutoff)
    assert not is_purge_eligible("done", None, before, cutoff)
    assert not is_purge_eligible("done", "", before, cutoff)


# --- key health (v1 key-healthcheck.test.ts) --------------------------------------------------------


def test_every_catalog_provider_and_speechmatics_has_a_probe() -> None:
    for name in [*catalog.PROVIDERS, "speechmatics"]:
        assert probe_for(f"{name}_api_key", "secret-key") is not None
    assert probe_for("unknown_api_key", "k") is None
    assert probe_for("storage.audio_retention_days", "k") is None


def test_no_probe_puts_the_key_in_the_url() -> None:
    for name in [*catalog.PROVIDERS, "speechmatics"]:
        p = probe_for(f"{name}_api_key", "secret-key")
        assert p is not None and "secret-key" not in p.url
        assert "secret-key" in "".join(p.headers.values())


def test_probe_shapes() -> None:
    gemini = probe_for("gemini_api_key", "k")
    assert gemini is not None
    assert (gemini.method, gemini.url) == (
        "GET", "https://generativelanguage.googleapis.com/v1beta/models",
    )  # fmt: skip
    assert gemini.headers == {"x-goog-api-key": "k"} and gemini.body is None
    openai = probe_for("openai_api_key", "k")
    assert openai is not None and (openai.method, openai.url) == (
        "GET", "https://api.openai.com/v1/models",
    )  # fmt: skip
    assert openai.headers == {"Authorization": "Bearer k"}
    sm = probe_for("speechmatics_api_key", "k")
    assert sm is not None and sm.url == "https://asr.api.speechmatics.com/v2/jobs?limit=1"
    # xAI keys usually lack the "list models" ACL: probe the endpoint the app uses (v1).
    grok = probe_for("grok_api_key", "k")
    assert grok is not None and (grok.method, grok.url) == (
        "POST", "https://api.x.ai/v1/chat/completions",
    )  # fmt: skip
    assert grok.body == {"model": "grok-3-mini", "max_tokens": 1,
                         "messages": [{"role": "user", "content": "ping"}]}  # fmt: skip


@pytest.mark.parametrize(
    ("status", "verdict"),
    [(200, "healthy"), (204, "healthy"), (429, "healthy"), (401, "unhealthy"), (403, "unhealthy"),
     (500, "unknown"), (503, "unknown"), (400, "unknown"), (404, "unknown"), (302, "unknown")],
)  # fmt: skip
def test_classify_status(status: int, verdict: str) -> None:
    v = classify_status(status)
    assert v.status == verdict and v.detail and str(status) in v.detail


def test_classify_error_is_unknown_and_names_only_the_type() -> None:
    v = classify_error(ConnectionError("https://x?key=secret"))
    assert v.status == "unknown" and "ConnectionError" in v.detail and "secret" not in v.detail


def test_summarize() -> None:
    verdicts = [Verdict("healthy", "a"), Verdict("unhealthy", "b"), Verdict("healthy", "c")]
    assert summarize(verdicts) == {"healthy": 2, "unhealthy": 1, "unknown": 0}
    assert summarize([]) == {"healthy": 0, "unhealthy": 0, "unknown": 0}
