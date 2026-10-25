"""ARC-04 review round 2: an unhandled error reaches Sentry exactly once, scrubbed.

The catch-all middleware answers the 500 itself, so Sentry's ASGI integration never sees the
exception; the catch-all must report it. Uses an in-memory transport (no network).
"""

import json
from collections.abc import Iterator
from typing import Any

import pytest
import sentry_sdk
from fastapi import APIRouter
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sentry_sdk.envelope import Envelope
from sentry_sdk.transport import Transport

import app.core.sentry as sentry_mod
from app.core.settings import Settings
from app.main import create_app

EVENTS: list[dict[str, Any]] = []


class MemoryTransport(Transport):
    def capture_envelope(self, envelope: Envelope) -> None:
        for item in envelope.items:
            if item.type == "event" and item.payload.json is not None:
                EVENTS.append(item.payload.json)


@pytest.fixture
def client() -> Iterator[TestClient]:
    EVENTS.clear()
    sentry_mod.reset_for_tests()
    s = Settings()
    s.sentry_dsn = SecretStr("https://abcdefabcdefabcdef@o1.ingest.sentry.io/1")
    sentry_mod.TEST_TRANSPORT = MemoryTransport
    app = create_app(s)
    router = APIRouter()

    @router.get("/boom")
    def boom() -> None:
        raise RuntimeError("kaboom password=hunter2")

    app.include_router(router)
    try:
        yield TestClient(app, raise_server_exceptions=False)
    finally:
        sentry_mod.TEST_TRANSPORT = None
        sentry_mod.reset_for_tests()


def test_unhandled_error_is_reported_once_and_scrubbed(client: TestClient) -> None:
    r = client.get("/boom?token=SECRETQ")
    sentry_sdk.flush()
    assert r.status_code == 500
    assert len(EVENTS) == 1
    dumped = json.dumps(EVENTS[0], default=str)
    assert "hunter2" not in dumped
    assert "SECRETQ" not in dumped
    assert EVENTS[0]["exception"]["values"][0]["type"] == "RuntimeError"


def test_domain_errors_are_not_reported(client: TestClient) -> None:
    client.get("/nope")  # 404
    sentry_sdk.flush()
    assert EVENTS == []
