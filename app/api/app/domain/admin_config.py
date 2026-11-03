"""Admin configuration rules (ARC-10c; port of v1 ``/api/admin/{keys,config,generation-config,
features,health}`` checks, ``lib/keys/guards.ts``, ``lib/admin/{config,health}.ts``). Pure.

v2 additions: provider keys are bounded and header-safe; known ``app_config`` keys are typed (a
wrong type would silently flip a flag); feature keys follow ``PREFIX-ID``; text sizes are capped.
"""

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from app.core.errors import BadRequest, UnprocessableEntity
from app.services.ai import catalog

Pick = tuple[str, str]

KEY_CONFIG_KEYS: tuple[str, ...] = tuple(
    f"{name}_api_key" for name in (*catalog.PROVIDERS, "speechmatics")
)
MAX_LABEL_CHARS = 80  # v1
MIN_KEY_CHARS = 8  # v1
MAX_KEY_CHARS = 512
MAX_REASON_CHARS = 200
MAX_CONFIG_STRING = 2000
FEATURE_STATUSES = ("done", "partial", "not_started")
FEATURE_PRIORITIES = ("high", "medium", "low")
FEATURE_TEXT_LIMITS = {
    "title": 300, "description": 5000, "user_story": 5000, "content": 200_000,
    "change_note": 2000, "module_name": 200,
}  # fmt: skip
FEATURE_ARRAYS = ("note_tags", "depends_on", "blocks", "key_files")
FEATURE_EDITABLE = (
    "title", "description", "content", "status", "priority", *FEATURE_ARRAYS, "change_note",
)  # fmt: skip
MAX_ARRAY_ITEMS = 100
MAX_ARRAY_ITEM_CHARS = 300

_HEADER_SAFE = re.compile(r"[\x21-\x7e]+")  # visible ASCII: a key goes in an HTTP header
_FEATURE_KEY = re.compile(r"[A-Z][A-Z0-9]{0,9}-[A-Z0-9]{1,10}")
_PREFIX = re.compile(r"[A-Z][A-Z0-9]{0,9}")


# --- provider keys --------------------------------------------------------------------------------


@dataclass(frozen=True)
class NewKey:
    config_key: str
    label: str
    key: str
    last4: str


def _str(body: Mapping[str, Any], name: str) -> str:
    value = body.get(name)
    return value.strip() if isinstance(value, str) else ""


def parse_new_key(body: Mapping[str, Any]) -> NewKey:
    config_key, label, key = _str(body, "configKey"), _str(body, "label"), _str(body, "key")
    if config_key not in KEY_CONFIG_KEYS:
        raise UnprocessableEntity(f"configKey must be one of: {', '.join(KEY_CONFIG_KEYS)}.")
    if not label:
        raise UnprocessableEntity("label is required.")
    if len(label) > MAX_LABEL_CHARS:
        raise UnprocessableEntity(f"label must be {MAX_LABEL_CHARS} chars or fewer.")
    if not key:
        raise UnprocessableEntity("key is required.")
    if len(key) < MIN_KEY_CHARS:
        raise UnprocessableEntity(f"key is too short (minimum {MIN_KEY_CHARS} characters).")
    if len(key) > MAX_KEY_CHARS:
        raise UnprocessableEntity(f"key is too long (maximum {MAX_KEY_CHARS} characters).")
    if not _HEADER_SAFE.fullmatch(key):
        raise UnprocessableEntity("key must not contain spaces or control characters.")
    return NewKey(config_key, label.replace("\x00", ""), key, key[-4:])


def parse_key_status(body: Mapping[str, Any]) -> tuple[Literal["active", "disabled"], str | None]:
    status = body.get("status")
    if status not in ("active", "disabled"):
        raise UnprocessableEntity('status must be "active" or "disabled".')
    reason = _str(body, "disabled_reason").replace("\x00", "")[:MAX_REASON_CHARS] or None
    return ("active", None) if status == "active" else ("disabled", reason)


def guard_last_active_key(
    action: Literal["disable", "delete"], config_key: str, active: int
) -> None:
    """v1 ``isLastActiveKey``: the last active key of a provider is never disabled or deleted
    (the env fallback is not a safety net in production)."""
    if active <= 1:
        hint = (
            "Add another key first."
            if action == "disable"
            else ("Disable it or add another key first.")
        )
        raise UnprocessableEntity(f'Cannot {action} the last active key for "{config_key}". {hint}')


# --- app_config -----------------------------------------------------------------------------------


def parse_config_value(key: str, body: Mapping[str, Any]) -> bool | int | float | str | None:
    if "value" not in body:
        raise UnprocessableEntity('Request body must include a "value" field.')
    value = body["value"]
    if key == "storage.audio_retention_days":
        ok = value is None or (
            isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 3650
        )
        if not ok:
            raise UnprocessableEntity(
                f"{key} must be null (keep forever) or a whole number of days from 1 to 3650."
            )
        return value  # type: ignore[no-any-return]
    if key == "user_hack_audio_render":
        if not isinstance(value, bool):
            raise UnprocessableEntity(f"{key} must be true or false.")
        return value
    if value is not None and not isinstance(value, bool | int | float | str):
        raise UnprocessableEntity(
            "value must be a JSON primitive (boolean, number, string, or null)."
        )
    if isinstance(value, str) and len(value) > MAX_CONFIG_STRING:
        raise UnprocessableEntity(f"value is too long (maximum {MAX_CONFIG_STRING} characters).")
    return value


# --- generation config ----------------------------------------------------------------------------


def _pick(raw: Any) -> Pick | None:
    if not isinstance(raw, Mapping):
        return None
    provider, model = raw.get("provider"), raw.get("model")
    if isinstance(provider, str) and isinstance(model, str) and provider and model:
        return provider, model
    return None


def parse_generation_config(
    body: Mapping[str, Any], registered: Sequence[Pick], current_allowed: Sequence[Pick]
) -> tuple[list[Pick] | None, Pick | None]:
    """(new allow-list or None, new system default or None), v1 rules: every allowed model is
    registered; the default must be in the (new or current) allow-list."""
    raw_allowed, raw_default = body.get("allowedModels"), body.get("systemDefault")
    allowed: list[Pick] | None = None
    if raw_allowed is not None:
        if not isinstance(raw_allowed, list) or not raw_allowed:
            raise BadRequest("allowedModels must be a non-empty array.")
        allowed = []
        for item in raw_allowed:
            pick = _pick(item)
            if pick is None:
                raise BadRequest("Each entry in allowedModels must have provider and model.")
            if pick not in registered:
                raise BadRequest(f"{pick[0]}:{pick[1]} is not in the provider registry.")
            if pick not in allowed:
                allowed.append(pick)
    default: Pick | None = None
    if raw_default is not None:
        default = _pick(raw_default)
        effective = allowed if allowed is not None else list(current_allowed)
        if default is None or default not in effective or default not in registered:
            shown = f"{default[0]}:{default[1]}" if default else "?"
            raise BadRequest(f"systemDefault ({shown}) must be in the allow-list and registry.")
    if allowed is None and default is None:
        raise BadRequest("Nothing to update.")
    return allowed, default


# --- features -------------------------------------------------------------------------------------


def _text(name: str, value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise UnprocessableEntity(f"{name} must be a string.")
    limit = FEATURE_TEXT_LIMITS.get(name, 300)
    if len(value) > limit:
        raise UnprocessableEntity(f"{name} is too long (maximum {limit} characters).")
    return value.replace("\x00", "")


def _array(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    items = [x.replace("\x00", "")[:MAX_ARRAY_ITEM_CHARS] for x in value if isinstance(x, str)]
    return items[:MAX_ARRAY_ITEMS]


def _status(value: Any) -> str:
    if value not in FEATURE_STATUSES:
        raise UnprocessableEntity("status must be done, partial, or not_started.")
    return str(value)


def _priority(value: Any) -> str | None:
    if value is not None and value not in FEATURE_PRIORITIES:
        raise UnprocessableEntity("priority must be high, medium, low, or null.")
    return value  # type: ignore[no-any-return]


def parse_feature_create(body: Mapping[str, Any]) -> dict[str, Any]:
    key = _str(body, "key").upper()
    prefix = _str(body, "module_prefix").upper()
    name, title = _str(body, "module_name"), _str(body, "title")
    for field, value in (("key", key), ("module_prefix", prefix), ("module_name", name),
                         ("title", title)):  # fmt: skip
        if not value:
            raise UnprocessableEntity(f"{field} is required.")
    if not _FEATURE_KEY.fullmatch(key):
        raise UnprocessableEntity("key must look like PREFIX-ID (letters, digits, one dash).")
    if not _PREFIX.fullmatch(prefix):
        raise UnprocessableEntity("module_prefix must be 1-10 letters or digits.")
    return {
        "key": key,
        "module_prefix": prefix,
        "module_name": _text("module_name", name),
        "title": _text("title", title),
        "description": _text("description", body.get("description")) or None,
        "user_story": _text("user_story", body.get("user_story")) or None,
        "content": _text("content", body.get("content")) or None,
        "status": _status(body.get("status", "not_started")),
        "priority": _priority(body.get("priority")),
        **{name: _array(body.get(name)) for name in FEATURE_ARRAYS},
    }


def parse_feature_update(body: Mapping[str, Any]) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    for name in FEATURE_EDITABLE:
        if name not in body:
            continue
        value = body[name]
        if name == "status":
            fields[name] = _status(value)
        elif name == "priority":
            fields[name] = _priority(value)
        elif name in FEATURE_ARRAYS:
            fields[name] = _array(value)
        else:
            fields[name] = _text(name, value)
            if name == "title" and not (fields[name] or "").strip():
                raise UnprocessableEntity("title must not be empty.")
    if not fields:
        raise BadRequest("No editable fields provided.")
    return fields


# --- health ---------------------------------------------------------------------------------------


def build_health_report(checks: Mapping[str, Mapping[str, Any]], ts: str) -> dict[str, Any]:
    degraded = any(c.get("status") == "error" for c in checks.values())
    return {"status": "degraded" if degraded else "ok", "ts": ts, "checks": dict(checks)}
