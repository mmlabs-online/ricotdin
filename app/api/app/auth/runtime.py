"""Per-app auth state (ARC-05): signing keys, mailer, origins and rate limiters.

Built once in ``create_app`` and stored on ``app.state.auth``. Rate limiters are in-process
(one uvicorn per container), like v1's login limiter.
"""

from dataclasses import dataclass, field
from datetime import timedelta

from app.auth.jwt import JwtKeys
from app.core.ratelimit import RateLimiter
from app.core.settings import Settings
from app.email.sender import Mailer, mailer_from_settings

VERIFY_TTL = timedelta(hours=24)
RESET_TTL = timedelta(hours=1)


def _per(count: int, seconds: int) -> RateLimiter:
    return RateLimiter(capacity=count, refill_per_second=count / seconds)


@dataclass
class Limiters:
    login_ip: RateLimiter = field(default_factory=lambda: _per(10, 15 * 60))
    login_account: RateLimiter = field(default_factory=lambda: _per(10, 15 * 60))
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

    @classmethod
    def from_settings(cls, settings: Settings) -> "AuthRuntime":
        pem = settings.jwt_private_key
        return cls(
            keys=JwtKeys.from_private_pem(pem.get_secret_value()) if pem else None,
            mailer=mailer_from_settings(settings),
            web_origin=settings.web_origin,
            origins=settings.allowed_origins,
            refresh_ttl=timedelta(days=settings.refresh_ttl_days),
        )
