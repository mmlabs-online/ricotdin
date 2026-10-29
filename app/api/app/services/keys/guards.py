"""Admin key guards (ARC-06; port of v1 ``lib/keys/guards.ts``). Pure."""

from collections.abc import Mapping
from typing import Any

# Everything an admin screen may show. Ciphertext, IV, tag and created_by never leave the server.
ADMIN_CONFIG_SAFE_FIELDS = (
    "id",
    "created_at",
    "config_key",
    "label",
    "last4",
    "status",
    "disabled_reason",
    "last_used_at",
    "health_status",
    "health_checked_at",
    "health_detail",
)


def is_last_active_key(active_count: int) -> bool:
    """Disabling or deleting would leave no active key for this config_key."""
    return active_count <= 1


def mask_admin_config(row: Mapping[str, Any]) -> dict[str, Any]:
    return {name: row.get(name) for name in ADMIN_CONFIG_SAFE_FIELDS}
