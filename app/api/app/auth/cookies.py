"""Refresh cookie and the Origin check for cookie-authenticated endpoints (ARC-05). Pure.

Web and API run on sibling subdomains of one site (owner decision 2026-10-26), so
``SameSite=Lax`` still sends the cookie on the SPA's credentialed fetches while blocking it on
cross-site requests. The cookie is host-only (no ``Domain``) and scoped to ``/auth`` (refresh +
logout). The Origin check stops another same-site subdomain from driving refresh/logout.
"""

from typing import Any

REFRESH_COOKIE = "__Secure-ricotdin_rt"
REFRESH_COOKIE_PATH = "/auth"


def refresh_cookie(token: str, max_age: int) -> dict[str, Any]:
    """Keyword arguments for ``Response.set_cookie``."""
    return {
        "key": REFRESH_COOKIE,
        "value": token,
        "max_age": max_age,
        "path": REFRESH_COOKIE_PATH,
        "secure": True,
        "httponly": True,
        "samesite": "lax",
    }


def origin_allowed(origin: str | None, allowed: list[str]) -> bool:
    return bool(origin) and origin in allowed
