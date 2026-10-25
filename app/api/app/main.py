"""Ricotdin v2 API (FastAPI) — application factory (ARC-04).

``create_app`` wires settings, logging, Sentry, security headers, CORS and error handling; the
database layer (``app.db.session``) and background hooks (worker/schedulers, ARC-08) are started
in the lifespan only when configured, so ``/health`` never depends on them.
"""

import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI

from app.core.http import SecurityHeadersMiddleware, install_cors, install_error_handlers
from app.core.logging import get_logger, setup_logging
from app.core.sentry import init_sentry
from app.core.settings import Settings, get_settings
from app.core.version import resolve_version

log = get_logger("app")

# Background tasks started with the app (ARC-08 registers the worker and schedulers here).
BackgroundHook = Callable[[FastAPI], Awaitable[Callable[[], Awaitable[None]]]]
BACKGROUND_HOOKS: list[BackgroundHook] = []

core = APIRouter(tags=["core"])


@core.get("/health")
def health() -> dict[str, str]:
    """Liveness for the image HEALTHCHECK: no DB or provider calls."""
    return {"status": "ok"}


@core.get("/version.json")
def version() -> dict[str, str]:
    """Running release (RICOTDIN_VERSION → BUILD_COMMIT → "unknown")."""
    return {"version": resolve_version(os.environ)}


def create_app(settings: Settings | None = None) -> FastAPI:
    s = settings or get_settings()
    setup_logging(s.log_level)
    init_sentry(
        s.sentry_dsn.get_secret_value() if s.sentry_dsn else None, resolve_version(os.environ)
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        from app.db.session import Database

        app.state.db = await Database.start(s)
        stops = [await hook(app) for hook in BACKGROUND_HOOKS]
        log.info("api started", extra={"version": resolve_version(os.environ)})
        try:
            yield
        finally:
            for stop in reversed(stops):
                await stop()
            await app.state.db.close()

    app = FastAPI(title="Ricotdin API", version=resolve_version(os.environ), lifespan=lifespan)
    app.add_middleware(SecurityHeadersMiddleware)
    install_cors(app, s.allowed_origins)
    install_error_handlers(app)
    app.include_router(core)
    return app


app = create_app()
