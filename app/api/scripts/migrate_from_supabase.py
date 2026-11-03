"""Copy all v1 data from Supabase into a v2 (Neon) database, and legacy audio into R2 (ARC-03).

    uv run --env-file .env.migrate python -m scripts.migrate_from_supabase \\
        --confirm-target <target host> (--r2-bucket <bucket> | --skip-storage) \\
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
Audio goes to the bucket named by ``--r2-bucket`` (credentials from the migrated
``storage_config``). Output is a Markdown report (hosts, counts, digests, row ids, storage
keys): never a secret, an email address or meeting content. Database errors are reported by
class and SQLSTATE only (their server message can quote row values).
Docs: docs/ops/v2-migration-rehearsal.md.
"""

import argparse
import http.client
import os
import sys
import tempfile
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Protocol, TextIO
from urllib.parse import quote, urlsplit

import psycopg
from boto3.exceptions import Boto3Error
from botocore.exceptions import BotoCoreError, ClientError
from psycopg import sql
from psycopg.rows import dict_row

from app.migration.checksum import RowDigest
from app.migration.plan import (
    DUPLICATE_ACTIVE_JOBS_SQL,
    column_drift,
    duplicate_active_jobs_problem,
    load_order,
    select_sql,
    upsert_sql,
)
from app.migration.report import Report, StorageResult, TableResult
from app.migration.transform import (
    AUTH_USER_COLUMNS,
    USER_COLUMNS,
    MigrationBlocked,
    map_auth_user,
    map_row,
    source_user_problems,
)
from app.services.crypto import DecryptError, EncryptedSecret, decrypt_with_key, parse_master_key
from app.services.storage.config import R2Config
from app.services.storage.ownership import is_owned_audio_key
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


class SourceStore(Protocol):
    def download(self, key: str, target: Path) -> None: ...


class TargetStore(Protocol):
    def size(self, key: str) -> int | None: ...
    def upload(self, path: Path, key: str, content_type: str) -> None: ...


class CopyError(Exception):
    """A storage copy failed; the message is safe to report (codes only)."""


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
            dict(zip(cat.columns[table], cat.types[table], strict=True)),
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
            queries[table] = upsert_sql(table, cat.columns[table], cat.types[table], cat.pks[table])
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
        cols = cat.columns[table]
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


def target_r2_config(tgt: psycopg.Connection[Any], master: bytes, bucket: str) -> R2Config | None:
    """Credentials from the migrated active storage_config; the bucket is the explicit one."""
    row = tgt.execute(
        "SELECT account_id, access_key_id, bucket, secret_ciphertext, secret_iv, secret_auth_tag "
        "FROM public.storage_config WHERE provider = 'r2' AND status = 'active' "
        "ORDER BY created_at DESC LIMIT 1"
    ).fetchone()
    if row is None:
        return None
    try:
        secret = decrypt_with_key(EncryptedSecret(row[3], row[4], row[5]), master)
        return replace(R2Config(row[0], row[1], secret, row[2]), bucket=bucket)
    except (DecryptError, ValueError):
        return None  # listed under secrets_failed / reported as a copy failure


# --- storage ---------------------------------------------------------------------------------


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

    def download(self, key: str, target: Path) -> None:
        url = f"{self._base}/storage/v1/object/{LEGACY_BUCKET}/{quote(key)}"
        req = urllib.request.Request(  # noqa: S310 - https checked in __init__
            url, headers={"Authorization": f"Bearer {self._key}", "apikey": self._key}
        )
        try:
            with self._opener.open(req, timeout=120) as resp, open(target, "wb") as fh:
                while chunk := resp.read(1024 * 1024):
                    fh.write(chunk)
        except urllib.error.HTTPError as exc:  # includes refused 3xx
            raise CopyError(f"supabase download HTTP {exc.code}") from None
        except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
            raise CopyError(f"supabase download {type(exc).__name__}") from None


def _boto_reason(exc: Exception) -> str:
    if isinstance(exc, ClientError):
        return str(exc.response.get("Error", {}).get("Code", "")) or "ClientError"
    return type(exc).__name__  # messages can name temp paths / buckets


class R2Target:
    def __init__(self, cfg: R2Config) -> None:
        self._cfg = cfg
        self._client = r2_client(cfg)

    def __repr__(self) -> str:
        return "R2Target()"

    def size(self, key: str) -> int | None:
        try:
            return int(self._client.head_object(Bucket=self._cfg.bucket, Key=key)["ContentLength"])
        except ClientError as exc:
            if _boto_reason(exc) in {"404", "NoSuchKey", "NotFound"}:
                return None
            raise CopyError(f"r2 head {_boto_reason(exc)}") from None
        except (BotoCoreError, Boto3Error) as exc:
            raise CopyError(f"r2 head {_boto_reason(exc)}") from None

    def upload(self, path: Path, key: str, content_type: str) -> None:
        try:
            self._client.upload_file(
                str(path), self._cfg.bucket, key, ExtraArgs={"ContentType": content_type}
            )
        except (ClientError, BotoCoreError, Boto3Error) as exc:  # S3UploadFailedError: Boto3Error
            raise CopyError(f"r2 upload {_boto_reason(exc)}") from None


def source_objects(src: psycopg.Connection[Any]) -> dict[str, tuple[int | None, str | None]]:
    return {
        name: (size, mime)
        for name, size, mime in src.execute(
            "SELECT name, (metadata->>'size')::bigint, metadata->>'mimetype' "
            "FROM storage.objects WHERE bucket_id = %s",
            (LEGACY_BUCKET,),
        )
    }


def copy_storage(
    tgt: psycopg.Connection[Any],
    objects: Mapping[str, tuple[int | None, str | None]],
    source: SourceStore,
    target: TargetStore | None,
    result: StorageResult,
) -> None:
    referenced = {
        r[0]
        for r in tgt.execute("SELECT audio_path FROM public.meetings WHERE audio_path IS NOT NULL")
    }
    result.unreferenced_objects = len(set(objects) - referenced)
    pending = tgt.execute(
        "SELECT id::text, user_id::text, audio_path FROM public.meetings "
        "WHERE storage_provider = 'supabase' AND audio_path IS NOT NULL ORDER BY created_at"
    ).fetchall()
    done: list[tuple[str, str]] = []
    for mid, uid, key in pending:
        if not is_owned_audio_key(key, uid, mid):
            result.failed.append(f"{key}: not <user_id>/<meeting_id>[.ext] of its row")
            continue
        if key not in objects:
            result.missing_at_source.append(key)
            continue
        if target is None:
            result.failed.append(f"{key}: no active, decryptable R2 storage_config in the target")
            continue
        want, mime = objects[key]
        try:
            have = target.size(key)
            if have is not None and (want is None or have == want):
                result.already_on_r2.append(key)  # e.g. an earlier run stopped before the update
            else:
                with tempfile.TemporaryDirectory() as tmp:
                    path = Path(tmp) / "audio"
                    source.download(key, path)
                    got = path.stat().st_size
                    if want is not None and got != want:
                        raise CopyError(f"downloaded {got} bytes, storage.objects says {want}")
                    target.upload(path, key, mime or "application/octet-stream")
                if target.size(key) != got:
                    raise CopyError("size on R2 differs after upload")
                result.copied.append(key)
        except CopyError as exc:
            result.failed.append(f"{key}: {exc}")
            continue
        except Exception as exc:  # noqa: BLE001 - keep "always a report"; class name only
            result.failed.append(f"{key}: unexpected {type(exc).__name__}")
            continue
        done.append((mid, key))
    if done:
        with tgt.transaction():
            tgt.execute("ALTER TABLE public.meetings DISABLE TRIGGER USER")
            with tgt.cursor() as cur:
                cur.executemany(
                    "UPDATE public.meetings SET storage_provider = 'r2' "
                    "WHERE id = %s::uuid AND storage_provider = 'supabase' AND audio_path = %s",
                    done,
                )
            tgt.execute("ALTER TABLE public.meetings ENABLE TRIGGER USER")


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
    source_store: SourceStore | None,
    target_store_for: Callable[[R2Config], TargetStore] | None = None,
    r2_bucket: str | None = None,
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
        storage_wanted = not (dry_run or skip_storage or source_store is None)
        objects = source_objects(src) if storage_wanted else {}
        src.rollback()  # end the snapshot before long downloads (an idle session may be cut)
        if dry_run:
            return report
        check_secrets(tgt, master, report)
        if not storage_wanted or source_store is None:
            report.storage.skipped = True
            return report
        if not r2_bucket:
            raise MigrationBlocked("--r2-bucket is required to copy audio")
        report.storage.bucket = r2_bucket
        cfg = target_r2_config(tgt, master, r2_bucket)
        target = target_store_for(cfg) if (cfg and target_store_for) else None
        try:
            copy_storage(tgt, objects, source_store, target, report.storage)
        except psycopg.Error as exc:
            report.errors.append(f"meetings storage_provider update: {db_error(exc)}")
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
    where.add_argument("--r2-bucket", help="destination bucket for legacy audio")
    where.add_argument("--skip-storage", action="store_true", help="tables and secrets only")
    parser.add_argument("--dry-run", action="store_true", help="preflight + source digests only")
    parser.add_argument("--report", default="migration-report.md", help="report file (Markdown)")
    args = parser.parse_args(argv)

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
    bucket = f", audio → bucket {args.r2_bucket}" if args.r2_bucket else ""
    print(f"source {host_of(source_url)} → target {host_of(target_url)}{bucket}", file=sys.stderr)
    try:
        report = run(
            source_url,
            target_url,
            master,
            source_store=store,
            target_store_for=R2Target,
            r2_bucket=args.r2_bucket,
            dry_run=args.dry_run,
            skip_storage=args.skip_storage,
        )
    except MigrationBlocked as exc:
        print(f"blocked: {exc}", file=sys.stderr)
        return 2
    except psycopg.Error as exc:
        print(f"database error: {db_error(exc)} (message withheld)", file=sys.stderr)
        return 2
    text = report.render()
    Path(args.report).write_text(text, encoding="utf-8")
    emit_report(text, sys.stdout)
    if report.blocked:
        return 2
    return 0 if report.passed or report.dry_run else 1


if __name__ == "__main__":
    raise SystemExit(main())
