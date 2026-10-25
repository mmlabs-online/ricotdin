"""Application settings from the environment (ARC-04). Server-only: nothing here reaches clients.

Database logins are separate per runtime role (CLAUDE.md §0.1 R1); ``DATABASE_URL`` (the owner)
is for migrations and tests only and is never read by the running API.
"""

import re
from functools import lru_cache

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

_ORIGIN = re.compile(r"^https?://[A-Za-z0-9.-]+(:\d{1,5})?$")


def parse_origins(raw: str) -> list[str]:
    """Comma-separated exact origins (scheme://host[:port]); no wildcards, paths or bare hosts."""
    out: list[str] = []
    for part in raw.split(","):
        origin = part.strip()
        if not origin:
            continue
        if not _ORIGIN.match(origin):
            raise ValueError(
                f"ALLOWED_ORIGINS: invalid origin {origin!r} (use scheme://host[:port])"
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
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    db_statement_timeout_ms: int = Field(default=15_000, alias="DB_STATEMENT_TIMEOUT_MS")
    db_lock_timeout_ms: int = Field(default=5_000, alias="DB_LOCK_TIMEOUT_MS")

    @property
    def allowed_origins(self) -> list[str]:
        return parse_origins(self.allowed_origins_raw)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
