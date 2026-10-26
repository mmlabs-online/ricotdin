"""Ricotdin v2 API (FastAPI) — application factory (ARC-04).

Served with ``uvicorn app.main:create_app --factory``: importing this module has no side
effects (no logging setup, no Sentry, no settings read). ``create_app`` wires logging, Sentry,
middleware and error handling; the database layer (``app.db.session``) and background hooks
(worker/schedulers, ARC-08) start in the lifespan, so ``/health`` never depends on them.
"""

import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AsyncExitStack, asynccontextmanager

from fastapi import APIRouter, FastAPI

from app.auth.runtime import AuthRuntime
from app.core.http import install_error_handlers, install_middleware
from app.core.logging import get_logger, setup_logging
from app.core.sentry import init_sentry
from app.core.settings import Settings, get_settings
from app.core.version import resolve_version
from app.routers import auth as auth_router
from app.routers import profile as profile_router

log = get_logger("app")

# Background tasks started with the app (ARC-08 registers the worker and schedulers here).
# A hook starts its task and returns an async ``stop`` callable.
BackgroundHook = Callable[[FastAPI], Awaitable[Callable[[], Awaitable[None]]]]
BACKGROUND_HOOKS: list[BackgroundHook] = []

core = APIRouter(tags=["core"])


@core.get("/health")
def health() -> dict[str, str]:
    """Liveness for the image HEALTHCHECK and uptime checks: no DB or provider calls."""
    return {"status": "ok"}


@core.head("/health", include_in_schema=False)
def health_head() -> None:
    """HEAD for uptime checkers (same answer, no body)."""


@core.get("/version.json")
def version() -> dict[str, str]:
    """Running release (RICOTDIN_VERSION → BUILD_COMMIT → "unknown")."""
    return {"version": resolve_version(os.environ)}


def create_app(settings: Settings | None = None) -> FastAPI:
    s = settings or get_settings()
    release = resolve_version(os.environ)
    setup_logging(s.log_level)
    init_sentry(s.sentry_dsn.get_secret_value() if s.sentry_dsn else None, release)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        from app.db.session import Database

        async with AsyncExitStack() as stack:
            app.state.db = await Database.start(s)
            stack.push_async_callback(app.state.db.close)
            for hook in BACKGROUND_HOOKS:  # each started hook is stopped even if a later one fails
                stack.push_async_callback(await hook(app))
            log.info("api started", extra={"version": release})
            yield

    docs = s.api_docs
    app = FastAPI(
        title="Ricotdin API",
        version=release,
        lifespan=lifespan,
        docs_url="/docs" if docs else None,
        redoc_url="/redoc" if docs else None,
        openapi_url="/openapi.json" if docs else None,
    )
    install_middleware(app, s.allowed_origins)
    install_error_handlers(app)
    app.state.auth = AuthRuntime.from_settings(s)  # bad JWT_PRIVATE_KEY / SMTP config fails here
    app.include_router(core)
    app.include_router(auth_router.router)
    app.include_router(auth_router.wellknown)
    app.include_router(profile_router.router)
    return app
