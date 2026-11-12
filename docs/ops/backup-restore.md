# Database backup & restore (ARC-20)

ricotdin's only database is `ricotdin` on the shared self-hosted Postgres. Its backups are part of the
deployment repository (`mmlabs-online/deployment`), not of this repo:

- **Nightly dumps:** the `pg-backup` sidecar (`postgres/compose.yml`) dumps every database at 02:00
  (Asia/Ho_Chi_Minh), `pg_dump --format=custom`. It keeps 7 daily, 4 weekly and 6 monthly dumps in
  `~/srv/backups/postgres/` on the Mac.
- **Offsite:** at 03:30 a LaunchAgent syncs those dumps to an encrypted rclone remote on R2
  (`ops/backup/rclone-sync.sh`). **rclone must be installed and configured first**
  (`ops/backup/RESTORE.md`, one-time setup); until then only the local copies exist.
- **Restore test:** `bash ops/backup/restore-test.sh ricotdin` restores the newest dump into a
  throwaway container (same pgvector image, ricotdin's extensions and role placeholders) and runs
  sanity queries. It never touches the live volume. Run it after setup and then every month.
- **Restore for real** (one app in place, or a full rebuild): `ops/backup/RESTORE.md`. After restoring
  `ricotdin` in place, run `provision_db_roles` again if the logins are missing
  (`docs/ops/self-hosted-postgres.md`).

Not in the dumps: roles (cluster-wide; ricotdin's are recreated by its migrations and
`provision_db_roles`), audio files (Google Drive), and the server secrets. Keep
`KEY_ENCRYPTION_SECRET` offline: without it a restored database cannot decrypt the stored provider keys
or the Drive grant. The worst case today is one day of data loss (no WAL archiving).

The previous backup workflow (`backup.yml`: Supabase, then Neon, uploaded to R2 under `db/` and
`db-v2/`) is removed. Objects it already wrote age out under that bucket's lifecycle, or the owner
deletes them.
