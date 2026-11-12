# DB backup & restore (v2 Neon, ARC-15; was OPS-03 for Supabase)

> **ARC-20 (2026-11-12): the v2 database is no longer Neon.** It is `ricotdin` on the shared
> self-hosted Postgres (deployment repo `postgres/`). That server is reachable only as
> `postgres:5432` on the Mac's internal `db` network, so anything that talks to it runs **on the
> Mac in the API image**. See `docs/ops/self-hosted-postgres.md` for migrations, logins and the
> Neon data move. Read the Neon steps below with that substitution: the target `DATABASE_URL` is the
> `ricotdin` owner URL from that page.
> Backups are now the deployment repo's `pg-backup` sidecar + offsite sync (`ops/backup/`,
> `restore-test.sh ricotdin`). `backup.yml` below only backs up Neon until Neon is deleted.

**Owner:** project owner. Workflow: `.github/workflows/backup.yml` · naming + retention:
`app/api/app/ops/backup_plan.py` (tests `app/api/tests/test_backup_plan.py`) · upload / prune:
`app/api/scripts/backup_r2.py`.

## What runs

Every day at **02:00 UTC** (and on demand via *Actions → db-backup → Run workflow*):

1. `pg_dump --format=custom` (pg_dump 18) of the Neon `main` branch: schema, data, grants.
2. Checks: the dump is not empty and contains `public.meetings` data.
3. `age -r <public key>`, then upload as `db-v2/ricotdin-v2-db-<yyyyMMdd>T<HHmm>Z.dump.age` (never
   overwrites an object).
4. Delete v2 backups older than **30 days** (never the newest; never objects with other names, so
   the old v1 `db/ricotdin-db-…` backups are left alone and expire with their own lifecycle rule).

The dump and the encryption run before any Python package is installed; package code only sees
the R2 token. A failed run fails the workflow (GitHub notifies the user who last edited the
`schedule` line); prune never runs after a failed upload. `schedule` runs only from the default
branch **`dev`** (CLAUDE.md §9k): the `backup` environment must release its secrets to `dev`.

**Not in the backup:**
- Database roles and logins. Recreate them with `alembic upgrade head` (the group roles) and
  `scripts.provision_db_roles` (the logins, new passwords).
- Audio and avatars, which live in Google Drive.
- Server env files (`/etc/mmlabs/ricotdin-*.env`) and Neon project settings.

**Neon has its own point-in-time restore** (history retention of the plan). Use it first for
"undo the last hour"; these dumps are for losing the project or the account.

Privacy: the dump holds every user's meetings, transcripts, password hashes and the encrypted
provider keys. Data deleted in the app stays in backups for up to 30 days.

## One-time setup

1. **age key pair** (on your machine, not on a server): `age-keygen -o ricotdin-backup.key`. It
   prints `Public key: age1…`.
   - Keep **two independent offline copies** of the key file.
   - Never put it in GitHub or on the home server.
   - The v1 key pair can be reused.
2. **R2 bucket:** reuse `ricotdin-db-backups` and its scoped token (*Object Read & Write*, that
   bucket only). Optional: add a lifecycle rule on `db-v2/` (~35 days) as a second line of defence.
3. **Backup login on Neon `main`** (the owner runs this in the Neon SQL editor):
   ```sql
   CREATE ROLE ricotdin_backup_login LOGIN BYPASSRLS PASSWORD '<generated>' CONNECTION LIMIT 2;
   GRANT pg_read_all_data TO ricotdin_backup_login;
   ```
   `BYPASSRLS` is required. pg_dump turns row security off, so without it the dump stops at the
   first RLS table ("query would be affected by row-level security policy"; checked on PG 18).
   The login can read everything but write nothing. If Neon refuses `BYPASSRLS` to your role, ask
   Neon support or use a dedicated branch. Never the owner URL: it can change the schema and data.
   - Use the **direct** connection string, not `-pooler`, with `sslmode=require`.
   - Never use the app / service / worker logins.
4. **GitHub Environment `backup`:**
   - *Deployment branches*: `main` + `dev`.
   - Add these **environment secrets**:

   | Secret | Value |
   |---|---|
   | `NEON_BACKUP_DATABASE_URL` | the URL from step 3 |
   | `AGE_RECIPIENT` | the `age1…` public key |
   | `R2_BACKUP_ACCOUNT_ID` | Cloudflare account id |
   | `R2_BACKUP_ACCESS_KEY_ID` / `R2_BACKUP_SECRET_ACCESS_KEY` | the scoped token |
   | `R2_BACKUP_BUCKET` | `ricotdin-db-backups` |

   - Delete the v1 secret `SUPABASE_DB_URL` (CLAUDE.md §8). After the cutover, also reset the
     Supabase `postgres` password.
5. Run it once: `gh workflow run backup.yml --ref dev`, then check that the object appears in the
   bucket. **ARC-15 done check:** the first nightly backup after go-live is uploaded.

## Restore

Restore into a **new, empty Neon branch or project** first, never straight over production.

```bash
# 1. Download the object from the R2 dashboard → backup.dump.age
age -d -i ricotdin-backup.key -o backup.dump backup.dump.age
pg_restore --list backup.dump | head          # readable archive?
# 2. Target = OWNER url of the empty branch (direct, not -pooler)
pg_restore --exit-on-error --no-owner --dbname "$TARGET_OWNER_URL" backup.dump
# 3. Logins (new passwords) + checks
cd app/api && uv run --env-file .env.restore python -m scripts.provision_db_roles --env-file .env.restore
psql "$TARGET_OWNER_URL" -c "select (select count(*) from meetings) meetings,
  (select count(*) from transcript_segments) segments, (select count(*) from users) users,
  (select version_num from alembic.alembic_version) revision;"
```

- **Group roles:** `ricotdin_app`, `ricotdin_service` and `ricotdin_worker` are cluster-wide and
  must exist before `pg_restore`, or the grants fail. A Neon branch made from `main` already has
  them. On a new project, run `alembic upgrade head` once against a **separate scratch database**
  of the same project (that creates the roles), drop it, then restore into the empty one.
- **Database-level privileges are not in the dump** (pg_dump without `--create`). Re-apply them
  after the restore, then check:
  ```sql
  REVOKE TEMPORARY ON DATABASE <db> FROM PUBLIC;   -- 0001 baseline, R8
  SELECT has_database_privilege('ricotdin_app', current_database(), 'TEMP');  -- must be false
  ```
- **Files:** the restored `storage_objects` rows point at the same Google Drive files. A restore
  to production therefore needs no file copy, as long as `drive_config` still holds a working token.
- Delete the decrypted files afterwards.

Tested on 2026-11-05 against a Postgres 18 scratch database at revision `0006`, in three checks:
- dump, list and `pg_restore --exit-on-error` into an empty database gave 27 tables at the same
  revision;
- a `pg_read_all_data` login without `BYPASSRLS` fails at the first RLS table;
- the same login with it dumps everything.

## Secret rotation

| Secret | When | How |
|---|---|---|
| R2 backup token | yearly, and at once on suspected exposure | new token → update the two secrets → *Run workflow* → revoke the old token |
| `ricotdin_backup_login` password | yearly, on exposure, or when a collaborator leaves | `ALTER ROLE … PASSWORD` → update `NEON_BACKUP_DATABASE_URL` → *Run workflow* |
| age key pair | only on suspected compromise | new pair → new `AGE_RECIPIENT`; keep the old private key 30 days (older backups need it), then destroy it |

## Restore-test log

Test a restore **once after go-live, then quarterly**, and after any key rotation. Always use the
stored private key: that proves the key works, not only the pipeline.

| Date | Backup object | Target branch | meetings / segments / users (source → restored) | Result |
|---|---|---|---|---|
| | | | | |
