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

    # Auth (ARC-05). Without JWT_PRIVATE_KEY the auth routes answer 503; without SMTP_HOST no
    # email is sent (register reports email_sent=false).
    jwt_private_key: SecretStr | None = Field(default=None, alias="JWT_PRIVATE_KEY")
    # Public key of the key replaced by `gen_jwt_key --rotate`; keep >= 16 min, then remove.
    jwt_previous_public_key: str | None = Field(default=None, alias="JWT_PREVIOUS_PUBLIC_KEY")
    web_origin_raw: str = Field(default="", alias="WEB_ORIGIN")  # SPA origin: links + CORS
    refresh_ttl_days: int = Field(default=30, ge=1, le=365, alias="REFRESH_TTL_DAYS")
    smtp_host: str | None = Field(default=None, alias="SMTP_HOST")
    smtp_port: int = Field(default=465, alias="SMTP_PORT")
    smtp_user: str | None = Field(default=None, alias="SMTP_USER")
    smtp_password: SecretStr | None = Field(default=None, alias="SMTP_PASSWORD")
    mail_from: str | None = Field(default=None, alias="MAIL_FROM")
    # Platform services (ARC-06): AES-256-GCM master key for admin_config / storage_config secrets.
    # MUST be the v1 value, otherwise every stored provider key and the R2 secret are lost.
    key_encryption_secret: SecretStr | None = Field(default=None, alias="KEY_ENCRYPTION_SECRET")

    @property
    def web_origin(self) -> str | None:
        origins = parse_origins(self.web_origin_raw)
        if len(origins) > 1:
            raise ValueError("WEB_ORIGIN: exactly one origin")
        return origins[0] if origins else None

    @property
    def allowed_origins(self) -> list[str]:
        """CORS + the Origin check of cookie endpoints: ALLOWED_ORIGINS plus WEB_ORIGIN."""
        origins = parse_origins(self.allowed_origins_raw)
        web = self.web_origin
        return origins + [web] if web and web not in origins else origins


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
