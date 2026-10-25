"""Application settings from the environment (ARC-04). Server-only: nothing here reaches clients.

Database logins are separate per runtime role (CLAUDE.md §0.1 R1); ``DATABASE_URL`` (the owner)
is for migrations and tests only and is never read by the running API.
"""

import re
from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

_ORIGIN = re.compile(r"^(https?)://([A-Za-z0-9.-]+)(:\d{1,5})?$")
_LOCAL_HOSTS = {"localhost", "127.0.0.1"}


def parse_origins(raw: str) -> list[str]:
    """Comma-separated exact origins (scheme://host[:port]); https only, except localhost dev."""
    out: list[str] = []
    for part in raw.split(","):
        origin = part.strip()
        if not origin:
            continue
        m = _ORIGIN.match(origin)
        if not m:
            raise ValueError(
                f"ALLOWED_ORIGINS: invalid origin {origin!r} (use scheme://host[:port])"
            )
        if m.group(1) == "http" and m.group(2) not in _LOCAL_HOSTS:
            raise ValueError(
                f"ALLOWED_ORIGINS: {origin!r} must use https (http only for localhost)"
            )
        if origin not in out:
            out.append(origin)
    return out


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    database_url_app: SecretStr | None = Field(default=None, alias="DATABASE_URL_APP")
    database_url_service: SecretStr | None = Field(default=None, alias="DATABASE_URL_SERVICE")
    database_url_worker: SecretStr | None = Field(default=None, alias="DATABASE_URL_WORKER")
    allowed_origins_raw: str = Field(default="", alias="ALLOWED_ORIGINS")
    sentry_dsn: SecretStr | None = Field(default=None, alias="SENTRY_DSN")
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = Field(
        default="INFO", alias="LOG_LEVEL"
    )
    api_docs: bool = Field(default=False, alias="API_DOCS")  # /docs, /redoc, /openapi.json
    db_statement_timeout_ms: int = Field(default=15_000, ge=1, alias="DB_STATEMENT_TIMEOUT_MS")
    db_lock_timeout_ms: int = Field(default=5_000, ge=1, alias="DB_LOCK_TIMEOUT_MS")
    # Pool size + overflow per engine; must stay below each login's CONNECTION LIMIT
    # (app 20, service 10, worker 5 — app/db/provision.py).
    db_pool_app: tuple[int, int] = (10, 5)
    db_pool_service: tuple[int, int] = (5, 3)
    db_pool_worker: tuple[int, int] = (2, 2)

    @property
    def allowed_origins(self) -> list[str]:
        return parse_origins(self.allowed_origins_raw)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
