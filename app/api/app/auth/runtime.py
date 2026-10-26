"""Per-app auth state (ARC-05): signing keys, mailer, origins and rate limiters.

Built once in ``create_app`` and stored on ``app.state.auth``. Rate limiters are in-process
(one uvicorn per container), like v1's login limiter.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, TypeVar

import anyio

from app.auth.jwt import JwtKeys
from app.core.ratelimit import RateLimiter
from app.core.settings import Settings
from app.email.sender import Mailer, mailer_from_settings

VERIFY_TTL = timedelta(hours=24)
RESET_TTL = timedelta(hours=1)
# argon2id costs ~64 MiB + ~50 ms per hash: bound how many run at once (memory DoS).
HASH_CONCURRENCY = 4
T = TypeVar("T")


def _per(count: int, seconds: int) -> RateLimiter:
    return RateLimiter(capacity=count, refill_per_second=count / seconds)


@dataclass
class Limiters:
    login_ip: RateLimiter = field(default_factory=lambda: _per(10, 15 * 60))
    # Per (account, client): an outsider cannot lock a user out from their own address.
    login_account_ip: RateLimiter = field(default_factory=lambda: _per(10, 15 * 60))
    # Per account across all clients: caps distributed guessing (looser, so lockout is costly).
    login_account: RateLimiter = field(default_factory=lambda: _per(100, 60 * 60))
    token_ip: RateLimiter = field(default_factory=lambda: _per(20, 15 * 60))  # verify + reset
    register_ip: RateLimiter = field(default_factory=lambda: _per(5, 60 * 60))
    email_ip: RateLimiter = field(default_factory=lambda: _per(5, 15 * 60))
    email_address: RateLimiter = field(default_factory=lambda: _per(3, 60 * 60))
    password_user: RateLimiter = field(default_factory=lambda: _per(5, 15 * 60))


@dataclass
class AuthRuntime:
    keys: JwtKeys | None
    mailer: Mailer
    web_origin: str | None
    origins: list[str]
    refresh_ttl: timedelta
    limiters: Limiters = field(default_factory=Limiters)
    _hash_slots: anyio.CapacityLimiter | None = field(default=None, repr=False)

    async def run_hash(self, fn: Callable[..., T], *args: Any) -> T:
        """Run a password hash/verify in a worker thread, at most HASH_CONCURRENCY at a time."""
        if self._hash_slots is None:  # created inside the running event loop
            self._hash_slots = anyio.CapacityLimiter(HASH_CONCURRENCY)
        return await anyio.to_thread.run_sync(fn, *args, limiter=self._hash_slots)

    @classmethod
    def from_settings(cls, settings: Settings) -> "AuthRuntime":
        pem = settings.jwt_private_key
        keys = JwtKeys.from_private_pem(pem.get_secret_value()) if pem else None
        if keys and settings.jwt_previous_public_key:
            keys = keys.with_previous(settings.jwt_previous_public_key)
        if keys and settings.web_origin is None:
            raise ValueError("WEB_ORIGIN is required when JWT_PRIVATE_KEY is set (email links)")
        return cls(
            keys=keys,
            mailer=mailer_from_settings(settings),
            web_origin=settings.web_origin,
            origins=settings.allowed_origins,
            refresh_ttl=timedelta(days=settings.refresh_ttl_days),
        )
