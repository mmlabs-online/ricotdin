> Moved from CLAUDE.md §0.5 (ARC-19). Rules here are binding.

### 0.5 v1 → v2 data migration (ARC-03, files ARC-18)

- `app/api/scripts/migrate_from_supabase.py` is an owner-run CLI; the pure logic lives in
  `app/migration/`. Runbook and rehearsal log: `docs/ops/v2-migration-rehearsal.md`.
- Env lives only in the git-ignored `app/api/.env.migrate`:
  - `SUPABASE_DB_URL` (session pooler), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`;
  - `MIGRATION_TARGET_DATABASE_URL`, an owner URL; never `DATABASE_URL`;
  - `KEY_ENCRYPTION_SECRET`.
  None of these is an app runtime variable.
- **Run** with `--confirm-target <host>` plus either `--confirm-drive-folder <folder id>` or
  `--skip-storage`. The folder id must equal the target's `drive_config.root_folder_id` (checked
  before anything is written, exit 2). Rehearsals connect a separate `ricotdin-rehearsal` Drive
  folder to their branch (`connect_gdrive --folder ricotdin-rehearsal`), never production.
- **Files (ARC-18):** every `meetings.audio_path` and `profiles.avatar_key` of the migrated rows,
  ownership-checked (`storage_plan.plan_object_copies`; a forged key is *rejected*, never read),
  read from its v1 store — `supabase` rows from Supabase Storage, `r2` rows and every avatar from
  the v1 R2 bucket (credentials of the migrated `storage_config`) — HEAD/GET only, never a write
  or delete; streamed to a temp file under a limit (audio 1 GB, avatar 5 MB), size + md5 checked,
  uploaded with `DriveStorage.upload_file` (Drive md5 = local md5) and mapped in
  `storage_objects`; then the meeting → `gdrive`. A mapped key is compared with its source
  (`same_file`), never re-uploaded; a mismatch fails and is left alone. `upsert_sql` keeps
  `gdrive` on a re-run while `audio_path` is unchanged. Reasons in the report are fixed codes
  (`drive upload <AppError.code>`, `r2 head <S3 code>`): never Drive / S3 messages.
- **Source:** one `REPEATABLE READ READ ONLY` snapshot; Supabase is never written.
- **Target:**
  - Upsert by primary key, in foreign-key order, one transaction per table, with user triggers
    off so `updated_at` values are kept.
  - Values travel as text: `col::text` → `%s::text::<type>`.
  - Session output settings are pinned on both sides.
  - `profiles.role` is taken from `users.role`.
  - The script reads the schema from the catalog, so a future migration needs no code change
    unless it renames or retypes a column. The preflight then blocks on the drift.
  - **A migration that creates a v2-only table** (no Supabase counterpart) must add it to
    `V2_ONLY_TABLES` in the script, or every run is blocked (BUG-020);
    `test_bug020_every_table_created_after_the_baseline_is_v2_only` enforces it.
- **Report:**
  - Order-independent digests per table, plus secrets and file results (copied / already in
    Drive / v2 files / missing / rejected / failed, mapped count + `storage_digest`).
  - PASS needs a full run (files not skipped) and no file failure; missing and rejected files
    are listed, not failures.
  - Database errors appear only as class and SQLSTATE. Never print psycopg messages: their
    DETAIL quotes row values.
  - Report files (`migration-report*.md`) are git-ignored.
- **The final run (ARC-15)** must happen after v1 writes stop and **before** v2 accepts logins,
  because a re-run overwrites `users.*`.
