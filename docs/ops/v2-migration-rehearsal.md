# v2 data migration: Supabase → Neon + Google Drive (ARC-03, ARC-18)

**Owner:** project owner. **Script:** `app/api/scripts/migrate_from_supabase.py`. Pure logic lives in
`app/api/app/migration/`; tests are `app/api/tests/test_migration_{transform,storage,integration}.py`.

The script copies the following from v1 into a v2 database that is at Alembic head:

- every v1 user, keeping the same id and the same bcrypt password hash, so nobody resets a password;
- every `public` table, upserted by primary key;
- every file a migrated row names — meeting audio (`meetings.audio_path`) and avatars
  (`profiles.avatar_key`) — copied into Google Drive under the same key (ARC-18). The sources are
  the v1 R2 bucket and legacy Supabase Storage (`recordings`); both are only read.

It then writes a report. Running it twice creates no duplicates.
**Done check for ARC-03 and ARC-18:** two rehearsals with a PASS report that includes the file copy
(log below). The final run is ARC-15.

## What it does

| Step | Detail |
|---|---|
| Preflight | Nothing is written if any check fails (exit code 2). The checks:<br>• the source login bypasses RLS<br>• the target is at Alembic head<br>• every v2 table exists in the source<br>• every column has the same name and type on both sides<br>• every target table has a primary key<br>• there are no anonymous users, no users without an email, and no two users whose emails differ only in case |
| Snapshot | All reads happen in one `REPEATABLE READ READ ONLY` transaction on Supabase, so the source is never written. The snapshot is closed before any file is downloaded.<br>Session output settings (time zone, date and interval style, float digits) are pinned on both sides, so the digests compare like with like. |
| Users | Each `auth.users` row becomes a `users` row:<br>• `id`, `email` and `encrypted_password` → `password_hash` are copied unchanged. ARC-05 rehashes the password to argon2 at the user's first v2 login.<br>• `role` comes only from `app_metadata.role`; anything else becomes `user`.<br>• `email_confirmed_at` → `email_verified_at`.<br>• An active ban, or a soft delete, sets `disabled_at`. A ban becomes permanent, which is fine because v1 only ever banned for 100 years. |
| Tables | Loaded in foreign-key order and streamed in batches of 500, one transaction per table. User triggers are off during the load, so the copied `updated_at` values stay. Values travel as Postgres text, so vectors, jsonb and timestamps are exact.<br>`profiles.role` is set from `users.role`.<br>A meeting already copied to Google Drive stays `gdrive` on a re-run (same `audio_path`). |
| Errors | A database error stops the run and appears in the report as `<table>: <class> <SQLSTATE>`, for example `users: UniqueViolation 23505`. The server's message is never printed, because it can quote row values such as an email address or a hash. |
| Secrets | Every `admin_config` and `storage_config` row is test-decrypted with `KEY_ENCRYPTION_SECRET`. Only row ids appear in the report. |
| Drive folder | Checked **before anything is written** (exit code 2): the target must have a `drive_config` row that decrypts with `KEY_ENCRYPTION_SECRET`, and its root folder id must equal **`--confirm-drive-folder`**. The first stderr line repeats the folder id. |
| Files | For every meeting audio key and every avatar key of the migrated rows:<br>1. Ownership: `<user_id>/<meeting_id>[.ext]` of its own meeting, or `avatars/<user_id>/<uuid>.<ext>` of its own profile. Anything else is **rejected** and never read.<br>2. The source follows the row: `storage_provider = 'supabase'` → Supabase Storage (service-role key, redirects refused, so the key is never sent anywhere else); `r2` and every avatar → the v1 R2 bucket, with the credentials of the migrated active `storage_config`. Only HEAD/GET (R2) and GET (Supabase) are used: nothing is ever written to or deleted from a source.<br>3. The file is streamed into a private temp directory with a size limit (audio 1 GB, avatar 5 MB); size and md5 must match the source (md5 when the source has one: a single-part ETag).<br>4. It is uploaded server-side into the Drive root folder (`DriveStorage.upload_file`: chunked resumable upload, Drive's md5 must equal the local md5), then mapped in `storage_objects`.<br>5. Only then does the meeting move to `gdrive`.<br>A key that is already in `storage_objects` is not uploaded again: its size + md5 are compared with the source ("Already in Drive"; recovery after an interrupted run). A mismatch is a failure and the file is left alone — delete that key from Drive and `storage_objects` by hand, then re-run. Meetings already on `gdrive` are left alone ("v2 files"). A file missing at the source is listed. Supabase objects that no row names are counted but not copied. |
| Report | Per table: row counts and an order-independent digest, source vs target. Also the embeddings count, the pgvector versions, the secrets result, the Drive folder, the file lists (copied, already in Drive, missing, rejected, failed), the number of mapped keys with an order-independent digest of (key, size, md5) — the same on a re-run —, and the verdict. It never contains a secret, an email address or meeting content. **PASS** needs all of these:<br>• every table matches<br>• no errors<br>• no source-only tables<br>• every secret decrypts<br>• no file failure (missing and rejected files are listed, not failures)<br>• the file copy was not skipped |

Exit codes: `0` PASS (or dry run), `1` FAIL, `2` blocked, database error, wrong `--confirm-target`
or wrong / missing Drive folder.

## One-time setup

1. **Local env files.** Both are git-ignored by `.env*`. Keep the repo outside OneDrive or any other
   synced folder.
   - Create each file **empty first**.
   - Restrict it:
     - cmd: `icacls app\api\.env.migrate /inheritance:r /grant:r "%USERNAME%:F"`
     - PowerShell: `icacls app\api\.env.migrate /inheritance:r /grant:r "$($env:USERNAME):F"`
     - Git Bash rewrites `/inheritance:r`, so don't run it there.
   - Check that `icacls app\api\.env.migrate` lists only you.
   - Then fill it in.

   `app/api/.env.migrate`:
   ```
   SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<key>
   MIGRATION_TARGET_DATABASE_URL=<OWNER url of the rehearsal branch, direct (no -pooler)>
   KEY_ENCRYPTION_SECRET=<the v1 value, same as /etc/mmlabs/ricotdin.env>
   ```
   `app/api/.env.rehearsal` (only for the alembic step, so the password never lands in shell history):
   ```
   DATABASE_URL=<same OWNER url as MIGRATION_TARGET_DATABASE_URL>
   ```
   - `SUPABASE_DB_URL` is the Session pooler on port **5432** (as for OPS-03). Never use the
     transaction pooler on 6543: the script needs a single snapshot. The user is `postgres`, which
     bypasses RLS.
   - **Percent-encode** special characters in passwords (`%` → `%25`, `@` → `%40`, …). A malformed
     URL can make libpq echo part of it.
   - For the key, prefer a Supabase **secret API key** (`sb_secret_…`) created only for this
     migration. Delete it afterwards. The legacy `service_role` JWT can only be retired by rotating
     the project's JWT secret.
   - The target has its own variable, never `DATABASE_URL` in `.env`, so a rehearsal can't
     write to the `dev` branch by accident.
2. **Google Drive.** The OAuth client from ARC-17 (`scripts/connect_gdrive.py` docstring) is
   reused. Each rehearsal branch gets its **own** Drive folder, `ricotdin-rehearsal`, connected
   with `connect_gdrive --folder ricotdin-rehearsal` (step 3 below), never the production folder.
   That folder is deleted after the rehearsal, so no copy outlives a later v1 delete or retention
   purge (PRV-02).
3. **Never point the target at Neon `main`** until ARC-15.

## Rehearsal (do it twice)

```bash
# 1. Throwaway branch from main (Neon console or CLI); put its OWNER connection string (direct)
#    into MIGRATION_TARGET_DATABASE_URL (.env.migrate) and DATABASE_URL (.env.rehearsal)
neonctl branches create --project-id dark-grass-92968821 --name rehearsal-YYYYMMDD --parent main

cd app/api
# 2. Schema
uv run --env-file .env.rehearsal alembic upgrade head
# 3. Connect the rehearsal Drive folder to the branch. provision_db_roles writes the runtime
#    logins (DATABASE_URL_SERVICE, …) into .env.rehearsal; add KEY_ENCRYPTION_SECRET (the v1
#    value) to .env.rehearsal too. connect_gdrive prints the account, folder name and FOLDER ID.
uv run --env-file .env.rehearsal python -m scripts.provision_db_roles --env-file .env.rehearsal
uv run --env-file .env.rehearsal python -m scripts.connect_gdrive --folder ricotdin-rehearsal
# 4. Preflight only (writes nothing)
uv run --env-file .env.migrate python -m scripts.migrate_from_supabase \
  --confirm-target <target host> --skip-storage --dry-run
# 5. Real run, then the same command again: the second report must also PASS (idempotency)
#    and show "Copied: 0" with the same digest
uv run --env-file .env.migrate python -m scripts.migrate_from_supabase \
  --confirm-target <target host> --confirm-drive-folder <folder id> --report migration-report-1.md
uv run --env-file .env.migrate python -m scripts.migrate_from_supabase \
  --confirm-target <target host> --confirm-drive-folder <folder id> --report migration-report-2.md
# 6. Optional spot checks on the branch (add JWT_PRIVATE_KEY from scripts.gen_jwt_key and
#    WEB_ORIGIN to .env.rehearsal; never use .env, which holds the dev branch):
uv run --env-file .env.rehearsal python -m scripts.drive_smoke
uv run --env-file .env.rehearsal uvicorn app.main:create_app --factory
#    POST /auth/login with a real v1 account → 200; users.password_hash now starts with $argon2id$;
#    GET /meetings/{id}/audio-url of a copied meeting plays
# 7. Record the summary below, delete the branch, then the Drive folder
neonctl branches delete rehearsal-YYYYMMDD --project-id dark-grass-92968821
#    Google Drive → My Drive → ricotdin-rehearsal → Move to trash, then empty it from the trash
```

- `--confirm-target` must equal the host of `MIGRATION_TARGET_DATABASE_URL`, and
  `--confirm-drive-folder` the folder id connected to that target. Those are the guards against
  migrating into the wrong branch or the wrong folder. The first stderr line shows the source
  host, the target host and the Drive folder id.
- `--skip-storage` copies tables and checks secrets only. Such a run never PASSes.
- The report files (`migration-report*.md`) are git-ignored: they list user ids and storage keys.
  Copy only the summary into the log below.
- The integration test already proves the login and rehash path and the file copy (fake Drive,
  fake sources) on a synthetic copy. Step 6 is extra confidence with real data.
- Deleting the branch deletes its `drive_config` row, but the rehearsal refresh token stays valid at
  Google until it is unused for 6 months. Revoking the app at Google would also revoke the dev and
  production connections, so leave it unless the rehearsal `.env` files may have leaked.

## Limits

- **v1 changes between two runs into the same target:**
  - A deleted row stays in v2, so its table shows `target > source` and the run FAILs.
  - A row re-created with a new id (requeued meeting, re-registered email) hits a unique key.
    The run reports `<table>: UniqueViolation 23505` and stops.
  - Either way, rehearse on a fresh branch each time.
- A re-run upserts every `users` column, which would undo v2-side password changes, demotions or
  disables. So the final run (ARC-15) must happen after v1 writes stop and **before v2 accepts
  logins**.
- An audio or avatar key that is not its own row's key is never copied: it shows under "Rejected".
  The run still PASSes (the file is simply not in v2: the worker fails such a meeting, the profile
  shows no avatar). A dry run does not check files, so the first real rehearsal is where this
  appears. It points to a data problem in v1 (use `/fix-bug`), not to a bug in the script.
- A v1 meeting whose file is missing or rejected keeps `storage_provider` `r2` / `supabase`; v2
  cannot play or process it.
- Users without a password (none expected) are migrated with an empty hash and must use
  "forgot password". The report counts them.

## After the cutover (ARC-15): retire the migration credentials

1. Supabase:
   - Delete the migration secret key. If the legacy `service_role` key was used, rotate the JWT
     secret, or pause or delete the project once its backup window ends.
   - Remove the `SUPABASE_*` lines from `/etc/mmlabs/ricotdin.env`.
2. Supabase `postgres` password:
   - Reset it.
   - Delete the `backup` environment secret `SUPABASE_DB_URL` and disable `backup.yml` (OPS-03),
     otherwise it fails every night.
3. Neon `main` owner password:
   - Reset it: rehearsal branches inherited it, and it sat in `.env.migrate`.
   - Confirm every rehearsal branch is deleted.
   - Re-run `scripts.provision_db_roles` on `main` if needed.
4. `KEY_ENCRYPTION_SECRET` stays in use by v2. It has now been in one more file, so plan a
   re-key (follow-up), at once if that file may have leaked.
5. Delete `app/api/.env.migrate`, `app/api/.env.rehearsal`, every `migration-report*.md`, and every
   `ricotdin-rehearsal` Drive folder. The v1 R2 buckets and the Supabase bucket stay until ARC-16.

## Rehearsal log

| # | Date | Target branch | Tables (rows) | Embeddings | Secrets OK / failed | Files copied / in Drive / missing / rejected / failed | Second run | Result |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-10-29 | `rehearsal-20261029` | 22/22 match (3763) | 324 → 324 | 10 / 0 | before ARC-18 (old R2 copy): 0 copied, 22 unreferenced | PASS, 22/22 | PASS (tables only; repeat with Drive) |
| 2 | | | | | | | | |
| 3 | | | | | | | | |

Rehearsal 1 ran before ARC-18 (its file step targeted R2), so it does not count for the Drive copy:
two rehearsals with the Drive copy are still needed.

Notes from rehearsal 1:
- The first preflight blocked on `meetings.pinned_at` and `meetings.audio_purged_at`. Production had never run
  v1 migrations 004 and 032. The owner applied both in the Supabase SQL editor on 2026-10-29.
  Migration 033 (BUG-003 revoke) was still missing in production at that time; it does not block the migration.
- The Supabase **Direct connection** is IPv6-only. Use the **shared Session pooler**
  (`aws-<n>-<region>.pooler.supabase.com:5432`, user `postgres.<ref>`); the IPv4 add-on is not needed.
- On a Windows console the script crashed while printing the report (`UnicodeEncodeError`, cp1252); the
  report file was complete, but the exit code was always 1. Fixed in BUG-019: characters the console
  cannot show are printed as `?`; the report file keeps the full text.
- All 45 meetings were already on R2, so no audio was copied and R2 was never contacted. The 22 objects
  left in the Supabase `recordings` bucket are not referenced by any meeting.
