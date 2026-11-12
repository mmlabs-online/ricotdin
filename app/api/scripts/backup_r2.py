"""Upload / prune encrypted v2 database backups in the dedicated R2 backup bucket (ARC-15).

Run by .github/workflows/backup.yml (CI only, never the app):

    uv run python -m scripts.backup_r2 upload <file.dump.age>  # → db-v2/ricotdin-v2-db-…
    uv run python -m scripts.backup_r2 prune                   # delete backups past the retention

Env (GitHub secrets of the `backup` environment): R2_BACKUP_ACCOUNT_ID, R2_BACKUP_ACCESS_KEY_ID,
R2_BACKUP_SECRET_ACCESS_KEY, R2_BACKUP_BUCKET; optional BACKUP_RETENTION_DAYS (default 30).
The token should be scoped to the backup bucket only. Nothing secret is printed: S3 failures
are reported by error code only (their messages can name the bucket or the endpoint).
"""

import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from app.ops.backup_plan import BACKUP_PREFIX, backup_object_key, select_expired_backups

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client
else:
    S3Client = Any

DEFAULT_RETENTION_DAYS = 30


def _env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise SystemExit(f"[backup] missing required env var {name}")
    return value


def _client() -> tuple[S3Client, str]:
    account = _env("R2_BACKUP_ACCOUNT_ID")
    client: S3Client = boto3.session.Session().client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=_env("R2_BACKUP_ACCESS_KEY_ID"),
        aws_secret_access_key=_env("R2_BACKUP_SECRET_ACCESS_KEY"),
        region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 5, "mode": "standard"}),
    )
    return client, _env("R2_BACKUP_BUCKET")


def _code(exc: Exception) -> str:
    if isinstance(exc, ClientError):
        return str(exc.response.get("Error", {}).get("Code", "")) or "ClientError"
    return type(exc).__name__


def upload(path: Path) -> int:
    if not path.is_file():
        print("[backup] usage: backup_r2 upload <file.dump.age> (file not found)", file=sys.stderr)
        return 2
    if path.suffix != ".age":
        print(
            "[backup] refusing to upload a file that is not age-encrypted (*.age)", file=sys.stderr
        )
        return 2
    client, bucket = _client()
    key = backup_object_key(datetime.now(UTC))
    with path.open("rb") as body:
        # IfNoneMatch='*': never overwrite an existing backup
        client.put_object(
            Bucket=bucket,
            Key=key,
            Body=body,
            ContentType="application/octet-stream",
            IfNoneMatch="*",
        )
    print(f"[backup] uploaded {key} ({path.stat().st_size} bytes)")
    return 0


def _keys(client: S3Client, bucket: str) -> list[str]:
    keys: list[str] = []
    for page in client.get_paginator("list_objects_v2").paginate(
        Bucket=bucket, Prefix=BACKUP_PREFIX
    ):
        keys += [o["Key"] for o in page.get("Contents", []) if "Key" in o]
    return keys


def prune() -> int:
    raw = os.environ.get("BACKUP_RETENTION_DAYS", "")
    try:
        days = int(raw) if raw else DEFAULT_RETENTION_DAYS
    except ValueError:
        days = 0
    if days < 1:
        print("[backup] BACKUP_RETENTION_DAYS must be a whole number >= 1", file=sys.stderr)
        return 2
    client, bucket = _client()
    expired = select_expired_backups(_keys(client, bucket), time.time(), days)
    for key in expired:
        client.delete_object(Bucket=bucket, Key=key)
        print(f"[backup] deleted {key}")
    print(f"[backup] prune done: {len(expired)} deleted, retention {days} days")
    return 0


def main(argv: list[str]) -> int:
    try:
        if argv[:1] == ["upload"] and len(argv) == 2:
            return upload(Path(argv[1]))
        if argv == ["prune"]:
            return prune()
    except (ClientError, BotoCoreError) as exc:
        print(f"[backup] {argv[0]} failed: {_code(exc)}", file=sys.stderr)
        return 1
    print("[backup] usage: backup_r2 upload <file.dump.age> | prune", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
