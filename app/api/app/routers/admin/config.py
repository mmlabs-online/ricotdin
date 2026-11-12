"""Admin configuration (ARC-10c; port of v1 ``/api/admin/{keys,config,generation-config,features,
health,storage}``, CLAUDE.md §9f, §9h, §9i, §9j).

Provider keys: ciphertext, IV, tag and the plaintext are never returned or logged; every
mutation writes one audit row with only ``{configKey, label}``; the last active key of a
provider is never disabled or deleted (rows locked while counting); ``keys.invalidate`` runs
after every commit so the pools see the change (CLAUDE.md §0.4). Storage is Google Drive in v2:
``GET /admin/storage`` reports its health; v1's R2 configuration / orphan routes are not ported.
"""

import json
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.errors import BadRequest, Conflict, NotFound, ServiceUnavailable
from app.core.logging import get_logger
from app.core.ratelimit import RateLimiter
from app.db.session import Database, get_database
from app.domain.admin import like_pattern, parse_list_params
from app.domain.admin_config import (
    KEY_CONFIG_KEYS,
    build_health_report,
    guard_last_active_key,
    parse_config_value,
    parse_feature_create,
    parse_feature_update,
    parse_generation_config,
    parse_key_status,
    parse_new_key,
)
from app.domain.admin_ops import is_stale_task
from app.domain.models import REGISTERED, allowed_models, model_label, system_default
from app.domain.rules import parse_uuid
from app.routers._common import SERVICE, enforce_limit, is_unique_violation, json_object, jsonb
from app.routers.admin._common import CurrentAdmin, write_audit
from app.services.platform import Platform, get_platform
from app.services.storage.base import StorageNotConfigured
from app.worker.schedule import TASKS
from app.worker.tasks.keyhealth import provider_of, run_key_health

router = APIRouter(prefix="/admin", tags=["admin"])
log = get_logger("admin.config")

Db = Annotated[Database, Depends(get_database)]
Plat = Annotated[Platform, Depends(get_platform)]

KEY_CHECKS_PER_HOUR = 10  # each run calls every provider with every stored key
_KEY_COLUMNS = (
    "id, created_at, updated_at, config_key, label, last4, status, disabled_reason, "
    "last_used_at, health_status, health_checked_at, health_detail"
)
_ENTRY_NOT_FOUND = "Config entry not found."
_ALL_ADMINS = uuid.UUID(int=0)  # one shared rate-limit bucket
_FEATURE_BODY_BYTES = 1024 * 1024
_ALWAYS_USED = ("gemini", "speechmatics")  # embeddings + transcription
_FEATURE_NOT_FOUND = "Feature not found."


def key_check_limiter() -> RateLimiter:
    return RateLimiter(capacity=KEY_CHECKS_PER_HOUR, refill_per_second=KEY_CHECKS_PER_HOUR / 3600)


def _invalidate(platform: Platform, config_key: str) -> None:
    provider = provider_of(config_key)
    platform.keys.invalidate(provider)


# --- provider keys --------------------------------------------------------------------------------


@router.get("/keys")
async def list_keys(admin: CurrentAdmin, db: Db) -> dict[str, Any]:
    async with db.role_transaction(SERVICE) as conn:
        rows = (
            await conn.execute(
                text(
                    f"SELECT {_KEY_COLUMNS} FROM public.admin_config "  # noqa: S608 - constant
                    "WHERE config_key = ANY(:keys) ORDER BY config_key, created_at, id"
                ),
                {"keys": list(KEY_CONFIG_KEYS)},
            )
        ).all()
    return {"keys": [dict(r._mapping) for r in rows]}


@router.post("/keys", status_code=201)
async def add_key(request: Request, admin: CurrentAdmin, db: Db, platform: Plat) -> Any:
    new = parse_new_key(await json_object(request))
    secret = platform.keys.encrypt(new.key)
    if secret is None:
        raise ServiceUnavailable(
            "Key storage is not configured. Set KEY_ENCRYPTION_SECRET on the server."
        )
    async with db.role_transaction(SERVICE) as conn:
        row = (
            await conn.execute(
                text(
                    "INSERT INTO public.admin_config (config_key, label, value_ciphertext, "  # noqa: S608
                    "value_iv, value_auth_tag, last4, status, created_by) VALUES (:k, :l, :c, "
                    f":iv, :t, :last4, 'active', :by) RETURNING {_KEY_COLUMNS}"
                ),
                {"k": new.config_key, "l": new.label, "c": secret.ciphertext, "iv": secret.iv,
                 "t": secret.auth_tag, "last4": new.last4, "by": admin.user_id},
            )
        ).one()  # fmt: skip
        await write_audit(conn, admin, "admin_config.create", "admin_config", str(row.id),
                          {"configKey": new.config_key, "label": new.label})  # fmt: skip
    _invalidate(platform, new.config_key)
    return JSONResponse(status_code=201, content=jsonable_encoder({"key": dict(row._mapping)}))


async def _entry(conn: AsyncConnection, entry_id: str) -> tuple[Any, int]:
    """The key row and its provider's active-key count. One advisory lock per provider first,
    so two admins changing two keys of one provider queue instead of deadlocking on each
    other's rows; the rows are then read under that lock."""
    eid = parse_uuid(entry_id)
    if eid is None:
        raise NotFound(_ENTRY_NOT_FOUND)
    found = (
        await conn.execute(
            text(
                "SELECT config_key FROM public.admin_config WHERE id = :id "
                "AND config_key = ANY(:keys)"
            ),
            {"id": eid, "keys": list(KEY_CONFIG_KEYS)},
        )
    ).first()
    if found is None:
        raise NotFound(_ENTRY_NOT_FOUND)
    await conn.execute(
        text("SELECT pg_advisory_xact_lock(hashtext('admin_config:' || :k))"),
        {"k": found.config_key},
    )
    row = (
        await conn.execute(
            text("SELECT id, config_key, label, status FROM public.admin_config WHERE id = :id"),
            {"id": eid},
        )
    ).first()
    if row is None:  # deleted while we waited
        raise NotFound(_ENTRY_NOT_FOUND)
    active = (
        await conn.execute(
            text(
                "SELECT count(*) FROM public.admin_config WHERE config_key = :k "
                "AND status = 'active'"
            ),
            {"k": row.config_key},
        )
    ).scalar_one()
    return row, int(active)


@router.patch("/keys/{entry_id}")
async def change_key(
    entry_id: str, request: Request, admin: CurrentAdmin, db: Db, platform: Plat
) -> dict[str, Any]:
    status, reason = parse_key_status(await json_object(request))
    async with db.role_transaction(SERVICE) as conn:
        entry, active = await _entry(conn, entry_id)
        if status == "disabled" and entry.status == "active":
            guard_last_active_key("disable", entry.config_key, active)
        row = (
            await conn.execute(
                text(
                    "UPDATE public.admin_config SET status = :s, disabled_reason = :r, "  # noqa: S608
                    f"updated_at = now() WHERE id = :id RETURNING {_KEY_COLUMNS}"
                ),
                {"s": status, "r": reason, "id": entry.id},
            )
        ).one()
        meta = {"configKey": entry.config_key, "label": entry.label}
        if reason:
            meta["disabled_reason"] = reason
        action = "admin_config.enable" if status == "active" else "admin_config.disable"
        await write_audit(conn, admin, action, "admin_config", str(entry.id), meta)
    _invalidate(platform, entry.config_key)
    return {"key": dict(row._mapping)}


@router.delete("/keys/{entry_id}")
async def delete_key(entry_id: str, admin: CurrentAdmin, db: Db, platform: Plat) -> dict[str, Any]:
    async with db.role_transaction(SERVICE) as conn:
        entry, active = await _entry(conn, entry_id)
        if entry.status == "active":
            guard_last_active_key("delete", entry.config_key, active)
        await conn.execute(text("DELETE FROM public.admin_config WHERE id = :id"), {"id": entry.id})
        await write_audit(conn, admin, "admin_config.delete", "admin_config", str(entry.id),
                          {"configKey": entry.config_key, "label": entry.label})  # fmt: skip
    _invalidate(platform, entry.config_key)
    return {"ok": True}


@router.get("/keys/healthcheck")
async def last_key_check(admin: CurrentAdmin, db: Db) -> dict[str, Any]:
    async with db.role_transaction(SERVICE) as conn:
        last = (
            await conn.execute(text("SELECT max(health_checked_at) FROM public.admin_config"))
        ).scalar_one()
    return {"lastCheckedAt": last}


@router.post("/keys/healthcheck")
async def run_key_check(
    request: Request, admin: CurrentAdmin, db: Db, platform: Plat
) -> dict[str, Any]:
    """Probe every stored key now (the worker does it daily, §9i). 10 runs per hour per process
    for all admins together (each run calls every provider with every key). Keys never travel
    in a URL and never come back."""
    enforce_limit(request.app.state.key_check_limiter, _ALL_ADMINS)
    if not platform.keys.has_master:
        raise ServiceUnavailable(
            "Key storage is not configured. Set KEY_ENCRYPTION_SECRET on the server."
        )
    summary = await run_key_health(db, platform, group=SERVICE)
    async with db.role_transaction(SERVICE) as conn:
        await write_audit(conn, admin, "admin_config.healthcheck", "admin_config", "",
                          {"summary": dict(summary)})  # fmt: skip
        rows = (
            await conn.execute(
                text(
                    "SELECT id, config_key, label, last4, health_status, health_detail, "
                    "health_checked_at FROM public.admin_config WHERE config_key = ANY(:keys) "
                    "ORDER BY config_key, created_at, id"
                ),
                {"keys": list(KEY_CONFIG_KEYS)},
            )
        ).all()
    return {
        "ranAt": datetime.now(UTC),
        "summary": dict(summary),
        "keys": [dict(r._mapping) for r in rows],
    }


# --- app_config -----------------------------------------------------------------------------------


@router.get("/config")
async def list_config(admin: CurrentAdmin, db: Db) -> dict[str, Any]:
    async with db.role_transaction(SERVICE) as conn:
        rows = (
            await conn.execute(
                text(
                    "SELECT key, value::text AS value, description, updated_at, updated_by "
                    "FROM public.app_config ORDER BY key"
                )
            )
        ).all()
    # value::text + json.loads: a jsonb string value must not be parsed twice
    return {"config": [{**dict(r._mapping), "value": json.loads(r.value)} for r in rows]}


@router.patch("/config/{key}")
async def update_config(
    key: str, request: Request, admin: CurrentAdmin, db: Db, platform: Plat
) -> dict[str, Any]:
    value = parse_config_value(key, await json_object(request))
    async with db.role_transaction(SERVICE) as conn:
        row = (
            await conn.execute(
                text(
                    "UPDATE public.app_config SET value = CAST(:v AS jsonb), updated_by = :by, "
                    "updated_at = now() WHERE key = :k "
                    "RETURNING key, value::text AS value, description, updated_at, updated_by"
                ),
                {"v": json.dumps(value), "by": admin.user_id, "k": key},
            )
        ).first()
        if row is None:
            raise NotFound(f'Unknown config key: "{key[:100]}".')
        await write_audit(conn, admin, "config.update", "config", key, {"value": value})
    platform.config.invalidate(key)
    return {"config": {**dict(row._mapping), "value": json.loads(row.value)}}


# --- generation config ----------------------------------------------------------------------------


async def _generation(conn: AsyncConnection) -> tuple[list[tuple[str, str]], tuple[str, str]]:
    rows = (
        await conn.execute(
            text(
                "SELECT key, value FROM public.app_settings WHERE key IN "
                "('generation.system_default', 'generation.allowed_models')"
            )
        )
    ).all()
    settings = {r.key: jsonb(r.value) for r in rows}
    return (
        allowed_models(settings.get("generation.allowed_models")),
        system_default(settings.get("generation.system_default")),
    )


def _generation_out(allowed: list[tuple[str, str]], default: tuple[str, str]) -> dict[str, Any]:
    return {
        "systemDefault": {"provider": default[0], "model": default[1]},
        "allowedModels": [{"provider": p, "model": m} for p, m in allowed],
    }


@router.get("/generation-config")
async def generation_config(admin: CurrentAdmin, db: Db) -> dict[str, Any]:
    async with db.role_transaction(SERVICE) as conn:
        allowed, default = await _generation(conn)
    return {
        **_generation_out(allowed, default),
        "registeredModels": [
            {"provider": p, "model": m, "label": model_label(p, m)} for p, m in REGISTERED
        ],
    }


@router.patch("/generation-config")
async def update_generation_config(request: Request, admin: CurrentAdmin, db: Db) -> dict[str, Any]:
    body = await json_object(request)
    async with db.role_transaction(SERVICE) as conn:
        await conn.execute(text("SELECT pg_advisory_xact_lock(hashtext('generation_config'))"))
        current_allowed, _ = await _generation(conn)
        allowed, default = parse_generation_config(body, list(REGISTERED), current_allowed)
        upsert = (
            "INSERT INTO public.app_settings (key, value, updated_by, updated_at) "
            "VALUES (:k, CAST(:v AS jsonb), :by, now()) ON CONFLICT (key) DO UPDATE SET "
            "value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()"
        )
        if allowed is not None:
            await conn.execute(text(upsert), {
                "k": "generation.allowed_models", "by": admin.user_id,
                "v": json.dumps([{"provider": p, "model": m} for p, m in allowed])})  # fmt: skip
        if default is not None:
            await conn.execute(text(upsert), {
                "k": "generation.system_default", "by": admin.user_id,
                "v": json.dumps({"provider": default[0], "model": default[1]})})  # fmt: skip
        new_allowed, new_default = await _generation(conn)
        if new_default not in new_allowed:  # the allow-list dropped the current default
            raise BadRequest("The system default must stay in the allow-list: change it first.")
        out = _generation_out(new_allowed, new_default)
        await write_audit(conn, admin, "generation_config.update", "app_settings", "generation",
                          out)  # fmt: skip
    return {"ok": True, "config": out}


# --- features -------------------------------------------------------------------------------------

_FEATURE_COLUMNS = (
    "id, created_at, updated_at, updated_by, key, source_path, module_prefix, module_name, "
    "title, user_story, description, content, status, priority, note_tags, depends_on, blocks, "
    "key_files, metadata, change_note"
)


def _feature(row: Any) -> dict[str, Any]:
    out = dict(row._mapping)
    out["metadata"] = jsonb(out.get("metadata")) or {}
    return out


@router.get("/features")
async def list_features(request: Request, admin: CurrentAdmin, db: Db) -> dict[str, Any]:
    """``?module_prefix&status&search&page&perPage`` (v1 default 200 per page)."""
    q = request.query_params
    paging = parse_list_params(q)
    raw = q.get("perPage", "200").strip()
    per_page = min(200, max(1, int(raw))) if raw.isdigit() and len(raw) < 6 else 200
    clauses: list[str] = []
    args: dict[str, Any] = {}
    if q.get("module_prefix"):
        clauses.append("module_prefix = :mp")
        args["mp"] = q["module_prefix"].strip().upper()[:10]
    if q.get("status"):
        clauses.append("status = :st")
        args["st"] = q["status"][:20]
    if paging.search:
        clauses.append(
            "(lower(key) LIKE :pat ESCAPE '\\' OR lower(title) LIKE :pat ESCAPE '\\' "
            "OR lower(coalesce(description, '')) LIKE :pat ESCAPE '\\')"
        )
        args["pat"] = like_pattern(paging.search)
    where = " AND ".join(clauses) or "TRUE"
    async with db.role_transaction(SERVICE) as conn:
        rows = (
            await conn.execute(
                text(
                    f"SELECT {_FEATURE_COLUMNS} FROM public.features WHERE {where} "  # noqa: S608
                    "ORDER BY module_prefix, key LIMIT :lim OFFSET :off"
                ),
                {**args, "lim": per_page, "off": (paging.page - 1) * per_page},
            )
        ).all()
    return {"features": [_feature(r) for r in rows]}


async def _find_feature(conn: AsyncConnection, ref: str) -> Any:
    fid = parse_uuid(ref)
    where, value = ("id = :v", fid) if fid else ("key = :v", ref.strip().upper()[:30])
    row = (
        await conn.execute(
            text(f"SELECT {_FEATURE_COLUMNS} FROM public.features WHERE {where}"),  # noqa: S608
            {"v": value},
        )
    ).first()
    if row is None:
        raise NotFound(_FEATURE_NOT_FOUND)
    return row


@router.post("/features", status_code=201)
async def create_feature(request: Request, admin: CurrentAdmin, db: Db) -> Any:
    fields = parse_feature_create(await json_object(request, max_bytes=_FEATURE_BODY_BYTES))
    cols = list(fields)  # fixed names from parse_feature_create, never from the request
    try:
        async with db.role_transaction(SERVICE) as conn:
            row = (
                await conn.execute(
                    text(
                        f"INSERT INTO public.features ({', '.join(cols)}, updated_by, metadata) "  # noqa: S608
                        f"VALUES ({', '.join(':' + c for c in cols)}, :by, '{{}}'::jsonb) "
                        f"RETURNING {_FEATURE_COLUMNS}"
                    ),
                    {**fields, "by": admin.email},
                )
            ).one()
            await write_audit(conn, admin, "feature.create", "feature", str(row.id),
                              {"key": row.key, "module_prefix": row.module_prefix,
                               "title": row.title})  # fmt: skip
    except IntegrityError as exc:
        if is_unique_violation(exc):
            raise Conflict(f'Feature key "{fields["key"]}" already exists.') from None
        raise
    return JSONResponse(status_code=201, content=jsonable_encoder({"feature": _feature(row)}))


@router.get("/features/{ref}")
async def get_feature(ref: str, admin: CurrentAdmin, db: Db) -> dict[str, Any]:
    async with db.role_transaction(SERVICE) as conn:
        return {"feature": _feature(await _find_feature(conn, ref))}


@router.patch("/features/{ref}")
async def update_feature(ref: str, request: Request, admin: CurrentAdmin, db: Db) -> Any:
    fields = parse_feature_update(await json_object(request, max_bytes=_FEATURE_BODY_BYTES))
    sets = ", ".join(f"{c} = :{c}" for c in fields)
    async with db.role_transaction(SERVICE) as conn:
        found = await _find_feature(conn, ref)
        row = (
            await conn.execute(
                text(
                    f"UPDATE public.features SET {sets}, updated_by = :by, updated_at = now() "  # noqa: S608
                    f"WHERE id = :id RETURNING {_FEATURE_COLUMNS}"
                ),
                {**fields, "by": admin.email, "id": found.id},
            )
        ).one()
        await write_audit(conn, admin, "feature.update", "feature", str(found.id),
                          {"key": found.key, "changed_fields": sorted(fields)})  # fmt: skip
    return {"feature": _feature(row)}


# --- health + storage -----------------------------------------------------------------------------


async def _drive(db: Database, platform: Platform) -> dict[str, Any]:
    try:
        async with db.role_transaction(SERVICE) as conn:
            storage = await platform.storage(conn)
            health = await storage.check()
    except StorageNotConfigured:
        return {"ok": False, "problem": "not_configured"}
    except Exception as exc:  # noqa: BLE001 - reported, never raised
        log.warning("drive health check failed (%s)", type(exc).__name__)
        return {"ok": False, "problem": "error"}
    return {"ok": health.ok, "problem": health.problem, "account_email": health.account_email,
            "quota_used": health.quota_used, "quota_limit": health.quota_limit}  # fmt: skip


@router.get("/health")
async def health(admin: CurrentAdmin, db: Db, platform: Plat) -> JSONResponse:
    """Database, Drive storage, stored provider keys (last check results, no live probe) and the
    worker's periodic tasks. 503 when anything is in error (v1)."""
    checks: dict[str, dict[str, Any]] = {}
    try:
        async with db.role_transaction(SERVICE) as conn:
            await conn.execute(text("SELECT 1"))
            keys = (
                await conn.execute(
                    text(
                        "SELECT config_key, count(*) FILTER (WHERE status = 'active') AS active, "
                        "count(*) FILTER (WHERE status = 'active' AND health_status = "
                        "'unhealthy') AS unhealthy FROM public.admin_config "
                        "WHERE config_key = ANY(:keys) GROUP BY config_key"
                    ),
                    {"keys": list(KEY_CONFIG_KEYS)},
                )
            ).all()
            tasks = (
                await conn.execute(
                    text("SELECT task, last_finished_at, last_status FROM public.scheduler_runs")
                )
            ).all()
            allowed, default = await _generation(conn)
        checks["database"] = {"status": "ok"}
    except Exception as exc:  # noqa: BLE001 - a health page reports, it does not crash
        checks["database"] = {"status": "error", "message": type(exc).__name__}
        keys, tasks, allowed, default = [], [], [], ("", "")
    drive = await _drive(db, platform)
    checks["storage"] = (
        {"status": "ok"} if drive["ok"] else {"status": "error", "message": drive["problem"]}
    )
    checks["key_encryption"] = (
        {"status": "ok"} if platform.keys.has_master
        else {"status": "error", "message": "KEY_ENCRYPTION_SECRET is not set"}
    )  # fmt: skip
    # Only providers in use can break processing: the rest are reported, never an error.
    in_use = {*_ALWAYS_USED, default[0], *(p for p, _ in allowed)}
    for r in keys:
        name = f"keys:{r.config_key}"
        problem = None
        if r.active == 0:
            problem = "no active key"
        elif r.unhealthy == r.active:
            problem = "every active key failed its check"
        if problem is None:
            checks[name] = {"status": "ok", "active": int(r.active)}
        else:
            used = provider_of(r.config_key) in in_use
            checks[name] = {"status": "error" if used else "warning", "message": problem}
    now = datetime.now(UTC)
    stale = [t.task for t in tasks if t.last_status == "error" or is_stale_task(
        t.last_finished_at, TASKS.get(t.task, 3600), now)]  # fmt: skip
    checks["worker"] = (
        {"status": "error", "message": f"stale or failing tasks: {', '.join(sorted(stale))}"}
        if stale else {"status": "ok"}
    )  # fmt: skip
    report = build_health_report(checks, now.isoformat())
    return JSONResponse(status_code=200 if report["status"] == "ok" else 503, content=report)


@router.get("/storage")
async def storage_status(admin: CurrentAdmin, db: Db, platform: Plat) -> dict[str, Any]:
    """Google Drive health (token, root folder, sharing, quota) and the stored file totals."""
    drive = await _drive(db, platform)
    async with db.role_transaction(SERVICE) as conn:
        files = (
            await conn.execute(
                text(
                    "SELECT count(*) AS n, COALESCE(sum(size_bytes), 0) AS bytes "
                    "FROM public.storage_objects"
                )
            )
        ).one()
    return {"drive": drive, "objects": {"count": int(files.n), "bytes": int(files.bytes)}}
