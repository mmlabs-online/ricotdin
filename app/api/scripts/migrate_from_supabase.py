"""Copy all v1 data from Supabase into a v2 (Neon) database, and every v1 file into Google Drive
(ARC-03, ARC-18).

    uv run --env-file .env.migrate python -m scripts.migrate_from_supabase \\
        --confirm-target <target host> (--confirm-drive-folder <folder id> | --skip-storage) \\
        [--dry-run] [--report PATH]

Env (script only, never app runtime; keep them in app/api/.env.migrate, never committed):
  SUPABASE_DB_URL                Supabase Session pooler URL (port 5432), a role with BYPASSRLS
  SUPABASE_URL                   https://<ref>.supabase.co (storage download)
  SUPABASE_SERVICE_ROLE_KEY      storage download only
  MIGRATION_TARGET_DATABASE_URL  OWNER URL of the target Neon branch (direct, not pooled);
                                 deliberately not DATABASE_URL
  KEY_ENCRYPTION_SECRET          the v1 value (test decrypt of every stored secret)

The source is read in ONE read-only REPEATABLE READ transaction (consistent snapshot), closed
before any file is downloaded; nothing is ever written there. The target is loaded table by
table, one transaction per table (rows streamed in batches inside it; user triggers off so
copied ``updated_at`` values stay), upserting by primary key, so a re-run adds no duplicates.
Files: every meeting audio key and avatar key of the migrated rows (ownership checked first) is
read from its v1 store — legacy Supabase Storage, or the v1 R2 bucket with the migrated
``storage_config`` credentials; both only read, never written — and uploaded server-side into the
target's ``drive_config`` root folder, which must equal ``--confirm-drive-folder`` (checked before
anything is written). Size and md5 are verified, the key is mapped in ``storage_objects`` and the
meeting moves to ``gdrive``. A re-run leaves ``gdrive`` meetings alone; a key that is mapped but
not marked yet (an interrupted run, every avatar) is compared with its source, never re-uploaded.
Output is a Markdown report (hosts, counts, digests, row ids, storage keys): never a secret, an
email address or meeting content. Database errors are reported by class and
SQLSTATE only (their server message can quote row values).
Docs: docs/ops/v2-migration-rehearsal.md.
"""

import argparse
import contextlib
import functools
import hashlib
import http.client
import logging
import os
import sys
import tempfile
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, TextIO
from urllib.parse import quote, urlsplit

import httpx2
import psycopg
from anyio.from_thread import BlockingPortal, start_blocking_portal
from boto3.exceptions import Boto3Error
from botocore.exceptions import BotoCoreError, ClientError
from psycopg import sql
from psycopg.rows import dict_row

from app.core.errors import AppError
from app.migration.checksum import RowDigest
from app.migration.plan import (
    DUPLICATE_ACTIVE_JOBS_SQL,
    column_drift,
    copied_columns,
    duplicate_active_jobs_problem,
    load_order,
    select_sql,
    upsert_sql,
)
from app.migration.report import Report, StorageResult, TableResult
from app.migration.storage_plan import (
    MAX_BYTES,
    V1_PROVIDERS,
    FileRow,
    Mapped,
    Step,
    content_type_for,
    etag_md5,
    plan_object_copies,
    same_file,
    storage_digest,
)
from app.migration.transform import (
    AUTH_USER_COLUMNS,
    USER_COLUMNS,
    MigrationBlocked,
    map_auth_user,
    map_row,
    source_user_problems,
)
from app.services.crypto import DecryptError, EncryptedSecret, decrypt_with_key, parse_master_key
from app.services.storage.base import StoredObject
from app.services.storage.config import DriveConfig, R2Config
from app.services.storage.gdrive import DriveClient, DriveStorage
from app.services.storage.media_token import MediaTokenSigner, derive_media_key
from app.services.storage.r2 import r2_client

API_ROOT = Path(__file__).resolve().parents[1]
# Tables with no v1 counterpart: never read from Supabase (auth tables; ARC-17 Drive storage).
V2_ONLY_TABLES = {
    "users",
    "refresh_tokens",
    "email_tokens",
    "drive_config",
    "storage_objects",
    "scheduler_runs",
    "meeting_note_versions",  # PRO-06: v2-only version history
}
# v2-only tables with nothing to copy (``users`` is filled from Supabase ``auth.users``).
NOT_COPIED_TABLES = V2_ONLY_TABLES - {"users"}
LEGACY_BUCKET = "recordings"
BATCH = 500
# Digests ignore columns the migration itself changes after the copy.
DIGEST_EXCLUDE = {"meetings": {"storage_provider"}}
# Pinned on both sides: text output (and target parsing) depends on them.
SESSION_SETTINGS = (
    "SET TIME ZONE 'UTC'",
    "SET datestyle = 'ISO, MDY'",
    "SET intervalstyle = 'postgres'",
    "SET extra_float_digits = 1",
    "SET statement_timeout = 0",
)


@dataclass
class Catalog:
    tables: set[str]
    columns: dict[str, list[str]]
    types: dict[str, list[str]]
    pks: dict[str, list[str]]
    fks: list[tuple[str, str]]


def host_of(url: str) -> str:
    return urlsplit(url).hostname or "?"


def db_error(exc: psycopg.Error) -> str:
    """Class and SQLSTATE only: the server message / DETAIL can quote row values."""
    return f"{type(exc).__name__} {exc.sqlstate or ''}".strip()


# --- catalog ---------------------------------------------------------------------------------


def read_catalog(conn: psycopg.Connection[Any]) -> Catalog:
    tables = {
        r[0]
        for r in conn.execute(
            "SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace "
            "AND relkind IN ('r', 'p')"
        )
    }
    columns: dict[str, list[str]] = {t: [] for t in tables}
    types: dict[str, list[str]] = {t: [] for t in tables}
    for table, col, typ in conn.execute(
        "SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) "
        "FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid "
        "WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') "
        "AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '' "
        "ORDER BY c.relname, a.attnum"
    ):
        columns[table].append(col)
        types[table].append(typ)
    pks: dict[str, list[str]] = {t: [] for t in tables}
    for table, col in conn.execute(
        "SELECT c.relname, a.attname FROM pg_index i "
        "JOIN pg_class c ON c.oid = i.indrelid "
        "JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord) ON true "
        "JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum "
        "WHERE i.indisprimary AND c.relnamespace = 'public'::regnamespace ORDER BY c.relname, k.ord"
    ):
        pks[table].append(col)
    fks = [
        (child, parent)
        for child, parent in conn.execute(
            "SELECT c.relname, p.relname FROM pg_constraint k "
            "JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid "
            "WHERE k.contype = 'f' AND c.relnamespace = 'public'::regnamespace "
            "AND p.relnamespace = 'public'::regnamespace"
        )
    ]
    return Catalog(tables, columns, types, pks, fks)


def alembic_head() -> str:
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    head = ScriptDirectory.from_config(Config(str(API_ROOT / "alembic.ini"))).get_current_head()
    if head is None:
        raise RuntimeError("no alembic head")
    return head


def _pgvector(conn: psycopg.Connection[Any]) -> str:
    row = conn.execute("SELECT extversion FROM pg_extension WHERE extname = 'vector'").fetchone()
    return str(row[0]) if row else "absent"


# --- preflight -------------------------------------------------------------------------------


def preflight(
    src: psycopg.Connection[Any], tgt: psycopg.Connection[Any], src_cat: Catalog, cat: Catalog
) -> tuple[list[str], dict[str, str]]:
    """Problems that block the run, and the upsert SQL per table (built up front so a bad
    identifier or type blocks before anything is written)."""
    problems: list[str] = []
    row = src.execute(
        "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user"
    ).fetchone()
    if not (row and row[0]):
        problems.append("source login does not bypass RLS: counts would be incomplete")
    head = alembic_head()
    has_alembic = tgt.execute(
        "SELECT to_regclass('alembic.alembic_version') IS NOT NULL"
    ).fetchone()
    version = (
        tgt.execute("SELECT version_num FROM alembic.alembic_version").fetchone()
        if has_alembic and has_alembic[0]
        else None
    )
    if version is None or version[0] != head:
        problems.append(f"target is not at alembic head {head} (run `alembic upgrade head`)")
    if cat.columns.get("users") != USER_COLUMNS:
        problems.append("target users columns differ from the migration's mapping")
    for table in sorted(cat.tables - V2_ONLY_TABLES):
        if table not in src_cat.tables:
            problems.append(f"source has no table public.{table}")
            continue
        problems += column_drift(
            table,
            dict(zip(src_cat.columns[table], src_cat.types[table], strict=True)),
            dict(zip(*copied_columns(table, cat.columns[table], cat.types[table]), strict=True)),
        )
    if "jobs" in src_cat.tables:
        dup = src.execute(DUPLICATE_ACTIVE_JOBS_SQL).fetchone()
        problem = duplicate_active_jobs_problem(int(dup[0]) if dup else 0)
        if problem:
            problems.append(problem)
    queries: dict[str, str] = {}
    for table in sorted(cat.tables):
        if not cat.pks.get(table):
            problems.append(f"target table {table} has no primary key")
            continue
        try:
            cols, types = copied_columns(table, cat.columns[table], cat.types[table])
            queries[table] = upsert_sql(table, cols, types, cat.pks[table])
        except MigrationBlocked as exc:
            problems.append(str(exc))
    return problems, queries


# --- load ------------------------------------------------------------------------------------


def digest_target(conn: psycopg.Connection[Any], table: str, cols: list[str]) -> RowDigest:
    d = RowDigest()
    # A server-side cursor needs a transaction (the target connection is in autocommit).
    with conn.transaction(), conn.cursor(name=f"d_{table}") as cur:
        cur.itersize = BATCH
        cur.execute(select_sql(table, cols))
        for row in cur:
            d.add(row)
    return d


def _batches(
    src: psycopg.Connection[Any], table: str, cols: list[str], users: list[dict[str, str | None]]
) -> Any:
    if table == "users":
        rows = [[u[c] for c in USER_COLUMNS] for u in users]
        for i in range(0, len(rows), BATCH):
            yield rows[i : i + BATCH]
        return
    with src.cursor(name=f"s_{table}", row_factory=dict_row) as cur:
        cur.execute(select_sql(table, cols))
        while batch := cur.fetchmany(BATCH):
            yield [map_row(table, r, cols) for r in batch]


def migrate_table(
    src: psycopg.Connection[Any],
    tgt: psycopg.Connection[Any],
    table: str,
    cols: list[str],
    query: str,
    users: list[dict[str, str | None]],
    user_roles: dict[str | None, str | None],
    *,
    dry_run: bool,
) -> tuple[RowDigest, int]:
    """Stream one table into the target; returns the source digest and fixed profile roles."""
    didx = [cols.index(c) for c in cols if c not in DIGEST_EXCLUDE.get(table, set())]
    role_at = cols.index("role") if table == "profiles" else -1
    id_at = cols.index("id") if table == "profiles" else -1
    digest, fixed = RowDigest(), 0
    ident = sql.Identifier(table)
    with tgt.transaction():
        if not dry_run:
            tgt.execute(sql.SQL("ALTER TABLE public.{} DISABLE TRIGGER USER").format(ident))
        with tgt.cursor() as out:
            for rows in _batches(src, table, cols, users):
                if role_at >= 0:
                    for r in rows:
                        want = user_roles.get(r[id_at])
                        if want and r[role_at] != want:
                            r[role_at], fixed = want, fixed + 1
                for r in rows:
                    digest.add([r[i] for i in didx])
                if not dry_run:
                    out.executemany(query, rows)
        if not dry_run:
            tgt.execute(sql.SQL("ALTER TABLE public.{} ENABLE TRIGGER USER").format(ident))
    return digest, fixed


def migrate_tables(
    src: psycopg.Connection[Any],
    tgt: psycopg.Connection[Any],
    cat: Catalog,
    queries: dict[str, str],
    users: list[dict[str, str | None]],
    report: Report,
    *,
    dry_run: bool,
) -> bool:
    """All tables in FK order. Stops at the first database error (recorded in the report)."""
    user_roles = {u["id"]: u["role"] for u in users}
    for table in load_order(cat.tables, cat.fks):
        if table in NOT_COPIED_TABLES:
            continue  # v2-only, nothing in v1
        cols, _ = copied_columns(table, cat.columns[table], cat.types[table])
        dcols = [c for c in cols if c not in DIGEST_EXCLUDE.get(table, set())]
        try:
            digest, fixed = migrate_table(
                src, tgt, table, cols, queries[table], users, user_roles, dry_run=dry_run
            )
            target = digest_target(tgt, table, dcols)
        except psycopg.Error as exc:
            report.errors.append(f"{table}: {db_error(exc)}")
            print(f"  {table}: {db_error(exc)}", file=sys.stderr)
            return False
        if fixed:
            report.notes.append(f"profiles.role set from users.role for {fixed} row(s)")
        report.tables.append(
            TableResult(table, digest.count, target.count, digest.hexdigest(), target.hexdigest())
        )
        print(f"  {table}: {digest.count} → {target.count}", file=sys.stderr)
    return True


# --- secrets ---------------------------------------------------------------------------------


def check_secrets(tgt: psycopg.Connection[Any], master: bytes, report: Report) -> None:
    for table, prefix in (("admin_config", "value"), ("storage_config", "secret")):
        cols = sql.SQL(", ").join(
            sql.Identifier(f"{prefix}_{p}") for p in ("ciphertext", "iv", "auth_tag")
        )
        query = sql.SQL("SELECT id::text, {} FROM public.{}").format(cols, sql.Identifier(table))
        for rid, ct, iv, tag in tgt.execute(query):
            label = f"{table} {rid}"
            try:
                decrypt_with_key(EncryptedSecret(ct, iv, tag), master)
            except (DecryptError, TypeError, ValueError):
                report.secrets_failed.append(f"{label} does not decrypt")
            else:
                report.secrets_ok.append(label)


def target_r2_config(tgt: psycopg.Connection[Any], master: bytes) -> R2Config | None:
    """The v1 bucket and its credentials, from the migrated active storage_config (read only)."""
    row = tgt.execute(
        "SELECT account_id, access_key_id, bucket, secret_ciphertext, secret_iv, secret_auth_tag "
        "FROM public.storage_config WHERE provider = 'r2' AND status = 'active' "
        "ORDER BY created_at DESC LIMIT 1"
    ).fetchone()
    if row is None:
        return None
    try:
        secret = decrypt_with_key(EncryptedSecret(row[3], row[4], row[5]), master)
        return R2Config(row[0], row[1], secret, row[2])
    except (DecryptError, ValueError):
        return None  # listed under secrets_failed; R2 rows are reported as copy failures


def target_drive_config(tgt: psycopg.Connection[Any], master: bytes) -> DriveConfig | None:
    """The target's ``drive_config`` (written there by ``scripts.connect_gdrive``), decrypted."""
    row = tgt.execute(
        "SELECT client_id, client_secret_ciphertext, client_secret_iv, client_secret_auth_tag, "
        "refresh_token_ciphertext, refresh_token_iv, refresh_token_auth_tag, root_folder_id, "
        "account_email FROM public.drive_config WHERE id"
    ).fetchone()
    if row is None:
        return None
    try:
        secret = decrypt_with_key(EncryptedSecret(row[1], row[2], row[3]), master)
        refresh = decrypt_with_key(EncryptedSecret(row[4], row[5], row[6]), master)
    except (DecryptError, ValueError):
        return None
    return DriveConfig(row[0], secret, refresh, row[7], row[8])


# --- storage (ARC-18: every v1 file → Google Drive) ------------------------------------------


@dataclass(frozen=True)
class SourceObject:
    size: int | None
    md5: str | None
    content_type: str | None


class SourceStore(Protocol):
    """A v1 file store. Read only: the migration never writes or deletes there."""

    def head(self, key: str) -> SourceObject | None: ...
    def download(self, key: str, target: Path, max_bytes: int) -> None: ...


class Downloader(Protocol):
    def download(self, key: str, target: Path, max_bytes: int) -> None: ...


class DriveTarget(Protocol):
    def upload(self, key: str, path: Path, content_type: str, max_bytes: int) -> Mapped:
        """Upload into the Drive root and map the key in the target's storage_objects."""
        ...


class CopyError(Exception):
    """A storage copy failed; the message is safe to report (codes only)."""


def _write_limited(chunks: Iterable[bytes], target: Path, max_bytes: int) -> None:
    written = 0
    with open(target, "wb") as fh:
        for chunk in chunks:
            written += len(chunk)
            if written > max_bytes:
                raise CopyError("source file is larger than the limit")
            fh.write(chunk)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """urllib would re-send Authorization/apikey to any redirect target."""

    def redirect_request(self, *_a: Any, **_k: Any) -> None:
        return None


class SupabaseStorage:
    def __init__(self, base_url: str, service_key: str) -> None:
        if not base_url.startswith("https://"):
            raise ValueError("SUPABASE_URL must be https://")
        self._base = base_url.rstrip("/")
        self._key = service_key
        self._opener = urllib.request.build_opener(_NoRedirect)

    def __repr__(self) -> str:
        return "SupabaseStorage()"

    def download(self, key: str, target: Path, max_bytes: int) -> None:
        url = f"{self._base}/storage/v1/object/{LEGACY_BUCKET}/{quote(key)}"
        req = urllib.request.Request(  # noqa: S310 - https checked in __init__
            url, headers={"Authorization": f"Bearer {self._key}", "apikey": self._key}
        )
        try:
            with self._opener.open(req, timeout=120) as resp:
                _write_limited(iter(lambda: resp.read(1024 * 1024), b""), target, max_bytes)
        except urllib.error.HTTPError as exc:  # includes refused 3xx
            raise CopyError(f"supabase download HTTP {exc.code}") from None
        except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
            raise CopyError(f"supabase download {type(exc).__name__}") from None


@dataclass
class SnapshotSource:
    """Legacy Supabase Storage: metadata from the source snapshot's ``storage.objects``."""

    objects: Mapping[str, SourceObject]
    downloader: Downloader

    def head(self, key: str) -> SourceObject | None:
        return self.objects.get(key)

    def download(self, key: str, target: Path, max_bytes: int) -> None:
        self.downloader.download(key, target, max_bytes)


def _boto_reason(exc: Exception) -> str:
    if isinstance(exc, ClientError):
        return str(exc.response.get("Error", {}).get("Code", "")) or "ClientError"
    return type(exc).__name__  # messages can name temp paths / buckets


class R2Source:
    """The v1 R2 bucket (HEAD + GET only)."""

    def __init__(self, cfg: R2Config) -> None:
        self._bucket = cfg.bucket
        self._client = r2_client(cfg)

    def __repr__(self) -> str:
        return "R2Source()"

    def head(self, key: str) -> SourceObject | None:
        try:
            h = self._client.head_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:
            if _boto_reason(exc) in {"404", "NoSuchKey", "NotFound"}:
                return None
            raise CopyError(f"r2 head {_boto_reason(exc)}") from None
        except (BotoCoreError, Boto3Error) as exc:
            raise CopyError(f"r2 head {_boto_reason(exc)}") from None
        return SourceObject(int(h["ContentLength"]), etag_md5(h.get("ETag")), h.get("ContentType"))

    def download(self, key: str, target: Path, max_bytes: int) -> None:
        try:
            body = self._client.get_object(Bucket=self._bucket, Key=key)["Body"]
            try:
                _write_limited(iter(lambda: body.read(1024 * 1024), b""), target, max_bytes)
            finally:
                body.close()
        except (ClientError, BotoCoreError, Boto3Error) as exc:
            raise CopyError(f"r2 download {_boto_reason(exc)}") from None


@dataclass
class _TargetObjectMap:
    """``storage_objects`` on the target owner connection (autocommit), for ``DriveStorage``."""

    conn: psycopg.Connection[Any]

    async def get(self, key: str, *, for_update: bool = False) -> StoredObject | None:
        row = self.conn.execute(
            "SELECT key, file_id, size_bytes, content_type, md5 FROM public.storage_objects "
            "WHERE key = %s",
            (key,),
        ).fetchone()
        return StoredObject(row[0], row[1], int(row[2]), row[3], row[4]) if row else None

    async def insert(self, obj: StoredObject) -> bool:
        row = self.conn.execute(
            "INSERT INTO public.storage_objects (key, file_id, size_bytes, content_type, md5) "
            "VALUES (%s, %s, %s, %s, %s) ON CONFLICT (key) DO NOTHING RETURNING key",
            (obj.key, obj.file_id, obj.size_bytes, obj.content_type, obj.md5),
        ).fetchone()
        return row is not None

    async def delete(self, key: str) -> None:
        raise CopyError("the migration never deletes a mapped file")


class GoogleDriveTarget:
    """Server-side uploads (``DriveStorage.upload_file``: chunked, md5-verified, then mapped)
    on one event loop in a background thread. Use as a context manager."""

    def __init__(
        self,
        cfg: DriveConfig,
        tgt: psycopg.Connection[Any],
        master: bytes,
        *,
        transport: httpx2.AsyncBaseTransport | None = None,  # tests: a fake Drive
    ) -> None:
        self._cfg, self._tgt, self._master, self._transport = cfg, tgt, master, transport
        self._stack = contextlib.ExitStack()
        self._portal: BlockingPortal | None = None
        self._storage: DriveStorage | None = None

    def __repr__(self) -> str:
        return "GoogleDriveTarget()"

    def __enter__(self) -> "GoogleDriveTarget":
        try:
            portal = self._stack.enter_context(start_blocking_portal())
            client = DriveClient(self._cfg, transport=self._transport)
            self._stack.callback(portal.call, client.aclose)
            signer = MediaTokenSigner(derive_media_key(self._master))  # unused by upload_file
            self._storage = DriveStorage(client, _TargetObjectMap(self._tgt), signer)
            self._portal = portal
        except BaseException:
            self._stack.close()
            raise
        return self

    def __exit__(self, *exc: object) -> None:
        self._stack.close()

    def upload(self, key: str, path: Path, content_type: str, max_bytes: int) -> Mapped:
        if self._portal is None or self._storage is None:
            raise CopyError("drive target used outside its context")
        upload = functools.partial(self._storage.upload_file, max_bytes=max_bytes)
        try:
            obj = self._portal.call(upload, key, path, content_type)
        except AppError as exc:  # StorageError, UploadRejected, KeyAlreadyStored, ...
            raise CopyError(f"drive upload {exc.code}") from None
        except (OSError, ValueError) as exc:
            raise CopyError(f"drive upload {type(exc).__name__}") from None
        return Mapped(obj.size_bytes, obj.md5)


def source_objects(src: psycopg.Connection[Any]) -> dict[str, SourceObject]:
    return {
        name: SourceObject(size, etag_md5(etag), mime)
        for name, size, mime, etag in src.execute(
            "SELECT name, (metadata->>'size')::bigint, metadata->>'mimetype', "
            "metadata->>'eTag' FROM storage.objects WHERE bucket_id = %s",
            (LEGACY_BUCKET,),
        )
    }


def file_rows(tgt: psycopg.Connection[Any]) -> list[FileRow]:
    """Every file a migrated row names: meeting audio, then avatars (v1 kept them on R2)."""
    meetings = tgt.execute(
        "SELECT audio_path, user_id::text, id::text, storage_provider FROM public.meetings "
        "WHERE audio_path IS NOT NULL ORDER BY created_at, id"
    ).fetchall()
    avatars = tgt.execute(
        "SELECT avatar_key, id::text FROM public.profiles WHERE avatar_key IS NOT NULL ORDER BY id"
    ).fetchall()
    return [FileRow("audio", k, u, m, p) for k, u, m, p in meetings] + [
        FileRow("avatar", k, u, None, "r2") for k, u in avatars
    ]


def _mapped(tgt: psycopg.Connection[Any]) -> dict[str, Mapped]:
    return {
        k: Mapped(int(size), md5)
        for k, size, md5 in tgt.execute("SELECT key, size_bytes, md5 FROM public.storage_objects")
    }


def _copy_one(step: Step, source: SourceStore, target: DriveTarget, have: Mapped | None) -> bool:
    """True = the file is in Drive and matches its source (copied now, or by an earlier run)."""
    row = step.row
    head = source.head(row.key)
    if head is None or head.size == 0:
        return False  # nothing to copy (an empty v1 file is listed as missing)
    if have is not None:
        if not same_file(have, head.size, head.md5):
            raise CopyError("the Drive copy differs from the source (delete the key, re-run)")
        return True
    content_type = content_type_for(row.key, head.content_type, row.kind)
    if content_type is None:
        raise CopyError("not a media file type")
    limit = MAX_BYTES[row.kind]
    if head.size is not None and head.size > limit:
        raise CopyError("source file is larger than the limit")
    with tempfile.TemporaryDirectory(prefix="ricotdin-migrate-") as tmp:
        path = Path(tmp) / "file"
        source.download(row.key, path, limit)
        got = path.stat().st_size
        if head.size is not None and got != head.size:
            raise CopyError(f"downloaded {got} bytes, the source says {head.size}")
        if head.md5 is not None and _md5(path) != head.md5:
            raise CopyError("downloaded file does not match the source md5")
        stored = target.upload(row.key, path, content_type, limit)
    if stored.size != got or (head.md5 is not None and stored.md5 not in (None, head.md5)):
        raise CopyError("the Drive copy differs from the download")
    return True


def _md5(path: Path) -> str:
    h = hashlib.md5(usedforsecurity=False)
    with open(path, "rb") as fh:
        while block := fh.read(1024 * 1024):
            h.update(block)
    return h.hexdigest()


def copy_storage(
    tgt: psycopg.Connection[Any],
    sources: Mapping[str, SourceStore | None],
    target: DriveTarget,
    result: StorageResult,
    *,
    legacy_objects: Iterable[str] = (),
) -> None:
    """Copy every v1 file named by a migrated row into Drive, then point those meetings at
    ``gdrive``. Never writes to or deletes from a source."""
    rows = file_rows(tgt)
    result.unreferenced_objects = len(set(legacy_objects) - {r.key for r in rows})
    mapped = _mapped(tgt)
    moved: list[tuple[str, str]] = []
    for step in plan_object_copies(rows, mapped):
        row = step.row
        if step.action == "reject":
            # The key failed the ownership pattern, so it is arbitrary user text: name the row.
            why = (
                "not its row's own key"
                if row.provider in (*V1_PROVIDERS, "gdrive")
                else "unknown storage provider"
            )
            where = (
                f"meeting {row.meeting_id}" if row.kind == "audio" else f"profile {row.owner_id}"
            )
            result.rejected.append(f"{where}: {why}")
            continue
        if step.action == "skip":
            result.v2_files += 1
            continue
        if step.action == "unmapped":
            result.failed.append(f"{row.key}: gdrive row with no storage_objects entry")
            continue
        source = sources.get(row.provider)
        if source is None:
            result.failed.append(f"{row.key}: no usable {row.provider} source configuration")
            continue
        try:
            ok = _copy_one(step, source, target, mapped.get(row.key))
        except CopyError as exc:
            result.failed.append(f"{row.key}: {exc}")
            continue
        except Exception as exc:  # noqa: BLE001 - keep "always a report"; class name only
            result.failed.append(f"{row.key}: unexpected {type(exc).__name__}")
            continue
        if not ok:
            result.missing_at_source.append(row.key)
            continue
        (result.copied if step.action == "copy" else result.already_in_drive).append(row.key)
        if row.kind == "audio" and row.meeting_id is not None:
            moved.append((row.meeting_id, row.key))
    if moved:
        with tgt.transaction():
            tgt.execute("ALTER TABLE public.meetings DISABLE TRIGGER USER")
            with tgt.cursor() as cur:
                cur.executemany(
                    "UPDATE public.meetings SET storage_provider = 'gdrive' WHERE id = %s::uuid "
                    "AND storage_provider IN ('r2', 'supabase') AND audio_path = %s",
                    moved,
                )
            tgt.execute("ALTER TABLE public.meetings ENABLE TRIGGER USER")
    keys = sorted({r.key for r in rows})
    entries = [
        (k, int(size), md5)
        for k, size, md5 in tgt.execute(
            "SELECT key, size_bytes, md5 FROM public.storage_objects WHERE key = ANY(%s)", (keys,)
        )
    ]
    result.mapped = len(entries)
    result.digest = storage_digest(entries)


# --- run -------------------------------------------------------------------------------------


def _source_users(src: psycopg.Connection[Any]) -> list[dict[str, Any]]:
    cols = ", ".join(
        "coalesce(is_anonymous, false) AS is_anonymous"
        if c == "is_anonymous"
        else f"{c}::text AS {c}"
        for c in AUTH_USER_COLUMNS
    )
    with src.cursor(row_factory=dict_row) as cur:
        cur.execute(
            f"SELECT {cols}, coalesce(banned_until > now(), false) AS banned FROM auth.users"  # noqa: S608 - fixed column list
        )
        return list(cur)


def run(
    source_url: str,
    target_url: str,
    master: bytes,
    *,
    source_store: Downloader | None,
    r2_source_for: Callable[[R2Config], SourceStore] | None = None,
    drive_target_for: Callable[
        [DriveConfig, psycopg.Connection[Any]], contextlib.AbstractContextManager[DriveTarget]
    ]
    | None = None,
    drive_folder: str | None = None,
    dry_run: bool = False,
    skip_storage: bool = False,
) -> Report:
    with (
        psycopg.connect(source_url) as src,
        psycopg.connect(target_url, autocommit=True) as tgt,
    ):
        src.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
        src.read_only = True
        for stmt in SESSION_SETTINGS:
            src.execute(stmt)
            tgt.execute(stmt)
        now = src.execute("SELECT now()::text").fetchone()
        report = Report(
            started_at=str(now[0]) if now else "?",
            source_host=host_of(source_url),
            target_host=host_of(target_url),
            dry_run=dry_run,
        )
        storage_wanted = not (dry_run or skip_storage or source_store is None)
        drive_cfg = None
        if storage_wanted or drive_folder is not None:
            # Checked before anything is written: the files must land in the folder the owner named.
            if not drive_folder:
                raise MigrationBlocked("--confirm-drive-folder is required to copy files")
            drive_cfg = target_drive_config(tgt, master)
            if drive_cfg is None:
                raise MigrationBlocked(
                    "the target has no decryptable drive_config (run scripts.connect_gdrive)"
                )
            if drive_cfg.root_folder_id != drive_folder:
                raise MigrationBlocked(
                    "--confirm-drive-folder does not match the target's drive_config folder"
                )
            report.storage.drive_folder = drive_folder
        src_cat, cat = read_catalog(src), read_catalog(tgt)
        report.source_only_tables = sorted(src_cat.tables - cat.tables)
        report.notes.append(f"pgvector: source {_pgvector(src)}, target {_pgvector(tgt)}")
        raw_users = _source_users(src)
        problems, queries = preflight(src, tgt, src_cat, cat)
        report.blocked = problems + source_user_problems(raw_users)
        if report.blocked:
            return report
        users = [map_auth_user(u, now=report.started_at) for u in raw_users]
        no_password = sum(1 for u in users if not u["password_hash"])
        if no_password:
            report.notes.append(f"{no_password} user(s) without a password: they must reset it")
        if not migrate_tables(src, tgt, cat, queries, users, report, dry_run=dry_run):
            return report
        emb = "SELECT count(*) FROM public.transcript_chunks WHERE embedding IS NOT NULL"
        report.embeddings_source = int(src.execute(emb).fetchone()[0])  # type: ignore[index]
        report.embeddings_target = int(tgt.execute(emb).fetchone()[0])  # type: ignore[index]
        objects = source_objects(src) if storage_wanted else {}
        src.rollback()  # end the snapshot before long downloads (an idle session may be cut)
        if dry_run:
            return report
        check_secrets(tgt, master, report)
        if not storage_wanted or source_store is None or drive_cfg is None:
            report.storage.skipped = True
            return report
        r2_cfg = target_r2_config(tgt, master)
        sources: dict[str, SourceStore | None] = {
            "supabase": SnapshotSource(objects, source_store),
            "r2": r2_source_for(r2_cfg) if (r2_cfg and r2_source_for) else None,
        }
        make_target = drive_target_for or (lambda cfg, conn: GoogleDriveTarget(cfg, conn, master))
        try:
            with make_target(drive_cfg, tgt) as target:
                copy_storage(tgt, sources, target, report.storage, legacy_objects=objects)
        except psycopg.Error as exc:
            report.errors.append(f"storage copy: {db_error(exc)}")
        return report


def emit_report(text: str, stream: TextIO | None) -> None:
    """Print the report without crashing on a console that cannot encode it (BUG-019).

    A Windows console is cp1252 with the strict error handler; characters it lacks (→, ✅)
    become ``?``. The report file always keeps the full text.
    """
    if stream is None:  # pythonw / no console: print() would have done nothing either
        return
    encoding = getattr(stream, "encoding", None) or "utf-8"
    stream.write(text.encode(encoding, errors="replace").decode(encoding) + "\n")


def _env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise SystemExit(f"{name} is not set (see docs/ops/v2-migration-rehearsal.md)")
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    parser.add_argument("--confirm-target", required=True, help="host of the target URL")
    where = parser.add_mutually_exclusive_group(required=True)
    where.add_argument(
        "--confirm-drive-folder", help="root folder id of the target's drive_config (files)"
    )
    where.add_argument("--skip-storage", action="store_true", help="tables and secrets only")
    parser.add_argument("--dry-run", action="store_true", help="preflight + source digests only")
    parser.add_argument("--report", default="migration-report.md", help="report file (Markdown)")
    args = parser.parse_args(argv)
    # Debug/info logs of these libraries carry signed headers, upload session URIs and tokens.
    for name in ("botocore", "boto3", "s3transfer", "urllib3", "httpx2", "httpcore2"):
        logging.getLogger(name).setLevel(logging.WARNING)

    source_url = _env("SUPABASE_DB_URL")
    target_url = _env("MIGRATION_TARGET_DATABASE_URL")
    if host_of(target_url) != args.confirm_target:
        print(
            f"--confirm-target does not match the target host ({host_of(target_url)})",
            file=sys.stderr,
        )
        return 2
    master = parse_master_key(_env("KEY_ENCRYPTION_SECRET"))
    store = None
    if not (args.dry_run or args.skip_storage):
        store = SupabaseStorage(_env("SUPABASE_URL"), _env("SUPABASE_SERVICE_ROLE_KEY"))
    files = (
        f", files → Drive folder {args.confirm_drive_folder}" if args.confirm_drive_folder else ""
    )
    print(f"source {host_of(source_url)} → target {host_of(target_url)}{files}", file=sys.stderr)
    try:
        report = run(
            source_url,
            target_url,
            master,
            source_store=store,
            r2_source_for=R2Source,
            drive_folder=args.confirm_drive_folder,
            dry_run=args.dry_run,
            skip_storage=args.skip_storage,
        )
    except MigrationBlocked as exc:
        print(f"blocked: {exc}", file=sys.stderr)
        return 2
    except psycopg.Error as exc:
        print(f"database error: {db_error(exc)} (message withheld)", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - codes only, never a message or a traceback
        print(f"unexpected error: {type(exc).__name__} (message withheld)", file=sys.stderr)
        return 2
    text = report.render()
    Path(args.report).write_text(text, encoding="utf-8")
    emit_report(text, sys.stdout)
    if report.blocked:
        return 2
    return 0 if report.passed or report.dry_run else 1


if __name__ == "__main__":
    raise SystemExit(main())
