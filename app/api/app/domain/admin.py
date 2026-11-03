"""Admin user-management rules (ARC-10a; port of v1 ``lib/admin/guards.ts``, ``userStatus.ts``,
``usageByUser.ts`` and the body checks of the ``/api/admin/users*`` routes). Pure.

Guards raise ``BadRequest`` with v1's messages (v1 answered 400); body errors raise
``UnprocessableEntity`` (v1 422) or ``BadRequest`` where v1 answered 400 (quota grants).
"""

import math
import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from app.core.errors import BadRequest, UnprocessableEntity

Role = Literal["user", "admin"]
BulkAction = Literal["disable", "enable", "set_role"]
UserStatus = Literal["unverified", "active", "disabled"]

ROLES: tuple[Role, ...] = ("user", "admin")
BULK_ACTIONS: tuple[BulkAction, ...] = ("disable", "enable", "set_role")
BULK_MAX_IDS = 50  # v1
MAX_SEARCH_CHARS = 200
MAX_NOTE_CHARS = 500  # v1
# v2: v1 had no upper bound. A grant this size is a typo, not a decision.
MAX_GRANT_MINUTES = 100_000
MAX_GRANT_QUERIES = 1_000_000

_MONTH = re.compile(r"^(\d{4})-(\d{2})$")
_ROLE_ERROR = "role must be one of: user, admin."
_GRANT_LIMITS = "Values must be finite numbers within the grant limits."


# --- guards ---------------------------------------------------------------------------------------


def guard_role_change(
    caller: uuid.UUID, target: uuid.UUID, current: str, new: str, admin_count: int
) -> None:
    """A demotion (admin → user) of yourself or of the last admin is refused; anything else
    passes. ``admin_count`` includes the target, before the change."""
    if not (current == "admin" and new == "user"):
        return
    if target == caller:
        raise BadRequest("You cannot demote yourself.")
    if admin_count <= 1:
        raise BadRequest("Cannot demote the last remaining admin.")


def guard_disable(caller: uuid.UUID, target: uuid.UUID, target_role: str, admin_count: int) -> None:
    if target == caller:
        raise BadRequest("You cannot disable your own account.")
    if target_role == "admin" and admin_count <= 1:
        raise BadRequest("Cannot disable the last remaining admin.")


def guard_delete(caller: uuid.UUID, target: uuid.UUID, target_role: str, admin_count: int) -> None:
    if target == caller:
        raise BadRequest("You cannot delete your own account.")
    if target_role == "admin" and admin_count <= 1:
        raise BadRequest("Cannot delete the last remaining admin.")


def exclude_self(caller: uuid.UUID, ids: list[uuid.UUID]) -> tuple[list[uuid.UUID], bool]:
    safe = [i for i in ids if i != caller]
    return safe, len(safe) < len(ids)


# --- bodies ---------------------------------------------------------------------------------------


def parse_role(body: Mapping[str, Any]) -> Role:
    role = body.get("role")
    if not isinstance(role, str) or role not in ROLES:
        raise UnprocessableEntity(_ROLE_ERROR)
    return role


def parse_status(body: Mapping[str, Any]) -> bool:
    disabled = body.get("disabled")
    if not isinstance(disabled, bool):
        raise UnprocessableEntity("disabled must be a boolean.")
    return disabled


def parse_bulk(body: Mapping[str, Any]) -> tuple[list[uuid.UUID], BulkAction, Role | None]:
    ids = body.get("ids")
    if not isinstance(ids, list) or not ids:
        raise UnprocessableEntity("ids must be a non-empty array.")
    if len(ids) > BULK_MAX_IDS:
        raise UnprocessableEntity(f"ids may not exceed {BULK_MAX_IDS} entries per request.")
    parsed: list[uuid.UUID] = []
    for raw in ids:
        try:
            value = uuid.UUID(raw) if isinstance(raw, str) else None
        except ValueError:
            value = None
        if value is None:
            raise UnprocessableEntity("ids must be user ids.")
        if value not in parsed:
            parsed.append(value)
    action = body.get("action")
    if not isinstance(action, str) or action not in BULK_ACTIONS:
        raise UnprocessableEntity(f"action must be one of: {', '.join(BULK_ACTIONS)}.")
    if action == "set_role":
        return parsed, "set_role", parse_role(body)
    return parsed, action, None


def _amount(value: Any, limit: float, *, integer: bool) -> float:
    if value is None:
        return 0
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise BadRequest(_GRANT_LIMITS)
    if not math.isfinite(value) or (integer and value != int(value)):
        raise BadRequest(_GRANT_LIMITS)
    if value < 0:
        raise BadRequest("Values must be non-negative.")
    if value > limit:
        raise BadRequest(_GRANT_LIMITS)
    return float(value)


def parse_quota_grant(body: Mapping[str, Any]) -> tuple[int, int, str | None]:
    """``{audio_minutes?, agent_queries?, note?}`` → (audio seconds, agent queries, note)."""
    minutes = _amount(body.get("audio_minutes"), MAX_GRANT_MINUTES, integer=False)
    queries = _amount(body.get("agent_queries"), MAX_GRANT_QUERIES, integer=True)
    if minutes == 0 and queries == 0:
        raise BadRequest("Provide at least one positive value.")
    note = body.get("note")
    clean = note.replace("\x00", "").strip()[:MAX_NOTE_CHARS] if isinstance(note, str) else ""
    return round(minutes * 60), int(queries), clean or None


# --- status + list --------------------------------------------------------------------------------


def user_status(*, disabled_at: datetime | None, email_verified_at: datetime | None) -> UserStatus:
    """Disabled wins (it blocks sign-in either way); else verified or not (v1)."""
    if disabled_at is not None:
        return "disabled"
    return "active" if email_verified_at is not None else "unverified"


def month_range(raw: str | None, now: datetime) -> tuple[str, datetime, datetime]:
    """``YYYY-MM`` → (label, start, end) in UTC, end exclusive; else the current month (v1)."""
    year, month = now.year, now.month
    m = _MONTH.match((raw or "").strip())
    if m and 1 <= int(m.group(2)) <= 12:
        year, month = int(m.group(1)), int(m.group(2))
    start = datetime(year, month, 1, tzinfo=UTC)
    end = datetime(year + month // 12, month % 12 + 1, 1, tzinfo=UTC)
    return f"{year:04d}-{month:02d}", start, end


@dataclass(frozen=True)
class ListParams:
    page: int
    per_page: int
    search: str


def _int(raw: Any, default: int) -> int:
    try:
        return int(str(raw).strip())
    except ValueError:
        return default


def parse_list_params(query: Mapping[str, Any]) -> ListParams:
    page = max(1, _int(query.get("page", "1"), 1))
    per_page = min(100, max(1, _int(query.get("perPage", "20"), 20)))
    search = str(query.get("search") or "").strip().lower()[:MAX_SEARCH_CHARS]
    return ListParams(page, per_page, search)


def like_pattern(search: str) -> str:
    """A ``LIKE … ESCAPE '\\'`` pattern matching ``search`` anywhere, wildcards taken literally."""
    escaped = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"
