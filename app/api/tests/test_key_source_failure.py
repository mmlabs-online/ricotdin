"""ARC-06 review: a failed admin_config lookup falls back to env keys (v1 behaviour), inside a
savepoint, and is retried after a short window instead of being cached for 30 s. Pure (fake
connection)."""

from contextlib import asynccontextmanager
from typing import Any

import anyio

from app.services.keys.source import FAILURE_TTL_S, KeySource


class FlakyConn:
    def __init__(self) -> None:
        self.calls = 0
        self.savepoints = 0
        self.fail = True

    @asynccontextmanager
    async def begin_nested(self) -> Any:
        self.savepoints += 1
        yield self

    async def execute(self, *_a: Any, **_k: Any) -> Any:
        self.calls += 1
        if self.fail:
            raise RuntimeError("connection reset")

        class Result:
            def all(self) -> list[Any]:
                return []

        return Result()


def test_db_failure_falls_back_to_env_in_a_savepoint_and_retries_soon() -> None:
    now = [0.0]
    src = KeySource(None, {"SPEECHMATICS_API_KEY": "env-key"}, clock=lambda: now[0])
    conn = FlakyConn()

    async def get() -> list[str]:
        return [k.key for k in await src.active_keys(conn, "speechmatics")]  # type: ignore[arg-type]

    assert anyio.run(get) == ["env-key"]
    assert conn.savepoints == 1
    assert anyio.run(get) == ["env-key"] and conn.calls == 1  # short failure cache
    now[0] = FAILURE_TTL_S + 0.1
    conn.fail = False
    assert anyio.run(get) == ["env-key"] and conn.calls == 2  # retried the database
