"""ARC-08e pure scheduler/task helpers. Ports of v1 ``tests/retention.test.ts`` (setting parse,
cutoff, eligibility) and ``tests/key-healthcheck.test.ts`` (probe shape per provider, verdicts),
plus the task table and the v2 rule that a probe never puts a key in a URL."""

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.domain.models import SYSTEM_DEFAULT
from app.services.ai import catalog
from app.worker.schedule import LEASE_S, TASK_TIMEOUT_S, TASKS
from app.worker.tasks.keyhealth import (
    MODEL_LIMITED,
    MODEL_OK,
    MODEL_UNAVAILABLE,
    MODEL_UNKNOWN,
    Verdict,
    classify_error,
    classify_model,
    classify_status,
    model_error_code,
    model_probe_for,
    models_to_check,
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


def test_bug_022_gemini_probe_generates_with_the_default_model() -> None:
    # Listing models succeeds even when the key cannot call the model the app uses.
    gemini = probe_for("gemini_api_key", "k")
    assert gemini is not None
    assert (gemini.method, gemini.url) == (
        "POST", "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    )  # fmt: skip
    assert catalog.PROVIDERS["gemini"].probe_model == SYSTEM_DEFAULT[1]
    assert gemini.headers == {"x-goog-api-key": "k"}
    assert gemini.body == {"contents": [{"role": "user", "parts": [{"text": "ping"}]}],
                           "generationConfig": {"maxOutputTokens": 1}}  # fmt: skip


def test_probe_shapes() -> None:
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
    claude = probe_for("anthropic_api_key", "k")
    assert claude is not None and (claude.method, claude.url) == (
        "GET", "https://api.anthropic.com/v1/models",
    )  # fmt: skip
    # same auth as the SDK the adapter uses (Bearer, anthropic-version 2026-10-21)
    assert claude.headers == {"Authorization": "Bearer k", "anthropic-version": "2026-10-21"}
    assert claude.body is None


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


# --- key health per model (ADM-12) -------------------------------------------------------------------


def test_models_to_check_are_the_allowed_models_of_that_provider() -> None:
    allowed = [("gemini", "gemini-3.8-flash"), ("openai", "gpt-4o"), ("openai", "gpt-4o-mini"),
               ("gemini", "gemini-2.5-flash"), ("openai", "gpt-4o")]  # fmt: skip
    assert models_to_check("openai_api_key", allowed) == ["gpt-4o", "gpt-4o-mini"]
    assert models_to_check("gemini_api_key", allowed) == ["gemini-3.8-flash", "gemini-2.5-flash"]
    assert models_to_check("anthropic_api_key", allowed) == []
    assert models_to_check("speechmatics_api_key", allowed) == []  # no generation models
    assert models_to_check("unknown_api_key", allowed) == []


def test_model_probe_shapes_generate_one_token() -> None:
    gem = model_probe_for("gemini_api_key", "gemini-3.8-flash", "k")
    assert gem is not None and (gem.method, gem.url) == (
        "POST", "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    )  # fmt: skip
    assert gem.headers == {"x-goog-api-key": "k"}
    assert gem.body == {"contents": [{"role": "user", "parts": [{"text": "ping"}]}],
                        "generationConfig": {"maxOutputTokens": 1}}  # fmt: skip
    oa = model_probe_for("openai_api_key", "gpt-4o-mini", "k")
    assert oa is not None and (oa.method, oa.url) == (
        "POST",
        "https://api.openai.com/v1/chat/completions",
    )
    assert oa.headers == {"Authorization": "Bearer k"}
    assert oa.body == {"model": "gpt-4o-mini", "max_tokens": 1,
                       "messages": [{"role": "user", "content": "ping"}]}  # fmt: skip
    grok = model_probe_for("grok_api_key", "grok-4", "k")
    assert grok is not None and grok.url == "https://api.x.ai/v1/chat/completions"
    assert grok.body is not None and grok.body["model"] == "grok-4"
    claude = model_probe_for("anthropic_api_key", "claude-haiku-5-5", "k")
    assert claude is not None and (claude.method, claude.url) == (
        "POST", "https://api.anthropic.com/v1/messages",
    )  # fmt: skip
    assert claude.headers == {"Authorization": "Bearer k", "anthropic-version": "2026-10-21"}
    assert claude.body == {"model": "claude-haiku-5-5", "max_tokens": 1,
                           "messages": [{"role": "user", "content": "ping"}]}  # fmt: skip


def test_a_retired_model_is_probed_as_its_replacement() -> None:
    p = model_probe_for("gemini_api_key", "gemini-2.5-flash", "k")
    assert p is not None and "/models/gemini-3.8-flash:" in p.url


def test_model_probes_never_put_the_key_in_the_url() -> None:
    for m in catalog.MODELS:
        p = model_probe_for(f"{m.provider}_api_key", m.model, "secret-key")
        assert p is not None and "secret-key" not in p.url
    assert model_probe_for("speechmatics_api_key", "x", "k") is None
    assert model_probe_for("openai_api_key", "not-in-catalog", "k") is None


@pytest.mark.parametrize(
    ("status", "code", "result"),
    [(200, None, MODEL_OK), (201, None, MODEL_OK),
     (429, None, MODEL_LIMITED), (429, "rate_limit_exceeded", MODEL_LIMITED),
     (429, "insufficient_quota", MODEL_UNAVAILABLE),  # out of credits: every call fails
     (404, None, MODEL_UNAVAILABLE), (403, None, MODEL_UNAVAILABLE), (401, None, MODEL_UNAVAILABLE),
     (400, "model_not_found", MODEL_UNAVAILABLE), (400, None, MODEL_UNKNOWN),
     (500, None, MODEL_UNKNOWN), (503, None, MODEL_UNKNOWN), (302, None, MODEL_UNKNOWN)],
)  # fmt: skip
def test_classify_model(status: int, code: str | None, result: str) -> None:
    assert classify_model(status, code) == result


@pytest.mark.parametrize(
    ("body", "code"),
    [({"error": {"code": "model_not_found", "type": "invalid_request_error"}}, "model_not_found"),
     ({"error": {"type": "insufficient_quota"}}, "insufficient_quota"),
     ({"error": {"type": "error"}, "type": "error"}, "error"),
     ({"error": {"status": "NOT_FOUND", "code": 404}}, None),  # Gemini: numeric code
     ({"error": "plain"}, None), ({}, None), (None, None), ([1], None), ("x", None)],
)  # fmt: skip
def test_model_error_code(body: Any, code: str | None) -> None:
    assert model_error_code(body) == code
