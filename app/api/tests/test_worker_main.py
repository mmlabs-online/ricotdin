"""ARC-08: ``python -m app.worker`` refuses to start with credentials it must not hold or while
pipeline steps are missing."""

import pytest

from app.worker.__main__ import main, startup_problems
from app.worker.steps import default_steps


def test_the_full_pipeline_is_registered() -> None:
    assert set(default_steps()) == {"start", "transcribe_poll", "analyse", "embed"}
    assert startup_problems({"DATABASE_URL_WORKER": "postgresql://w"}, default_steps()) == []
    steps = {k: v for k, v in default_steps().items() if k != "embed"}
    assert startup_problems({"DATABASE_URL_WORKER": "postgresql://w"}, steps) == [
        "pipeline steps not implemented yet: embed"
    ]


def test_complete_pipeline_with_only_the_worker_login_starts() -> None:
    async def step(ctx: object) -> object:
        raise NotImplementedError

    steps = dict.fromkeys(("start", "transcribe_poll", "analyse", "embed"), step)
    assert startup_problems({"DATABASE_URL_WORKER": "postgresql://w"}, steps) == []  # type: ignore[arg-type]
    assert startup_problems(
        {"DATABASE_URL_WORKER": "postgresql://w", "DATABASE_URL_SERVICE": "postgresql://s"},
        steps,  # type: ignore[arg-type]
    ) == ["DATABASE_URL_SERVICE must not be set in the worker container"]


def test_main_refuses_and_exits_2(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("DATABASE_URL", "DATABASE_URL_APP", "DATABASE_URL_SERVICE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("DATABASE_URL_WORKER", "postgresql://w@127.0.0.1:1/x")
    monkeypatch.setenv("DATABASE_URL_SERVICE", "postgresql://s@127.0.0.1:1/x")
    assert main() == 2  # a forbidden credential: never connects
    monkeypatch.setenv("DATABASE_URL_APP", "postgresql://a@127.0.0.1:1/x")
    assert main() == 2
