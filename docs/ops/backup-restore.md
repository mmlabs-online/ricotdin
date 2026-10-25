# DB backup & restore (OPS-03)

**Applies to:** Ricotdin on Supabase **Free** (no built-in backups). **Owner:** project owner.
Workflow: `.github/workflows/backup.yml` · Retention logic: `lib/backup/retention.ts` · Upload/prune: `scripts/backup/r2.ts`.

## What runs

Every day at **02:00 UTC** (and on demand via *Actions → db-backup → Run workflow*):

1. `supabase db dump` → `roles.sql`, `schema.sql`, `data.sql`
2. `tar czf` → `age -r <public key>` → upload as `db/ricotdin-db-<yyyyMMdd>T<HHmm>Z.tar.gz.age`
3. Delete backups older than **30 days** (never the newest; never objects with other names)

A failed run fails the workflow → GitHub notifies the user who last edited the `schedule` line. Prune never
runs after a failed upload.

**Which branch runs it:** GitHub runs `schedule` only for workflow files on the **default branch, which is
`dev`** (CLAUDE.md §9k). The `backup` environment must therefore release its secrets to `dev`; set its
deployment branches to `main` + `dev` (Settings → Environments → `backup`). Manual runs:
`gh workflow run backup.yml --ref dev`. The six secrets listed in *One-time setup* step 4 must exist as **environment** secrets of
`backup` — until they do, every run fails at "Check secrets are set" (BUG-018).

What is **not** in the backup: audio files (they live in R2 and are purged by policy, PRV-02),
Storage buckets, Supabase project settings (auth providers, SMTP, hooks — re-apply from CLAUDE.md §9a).

Privacy: data deleted in the app (meetings, transcripts) remains in backups for up to 30 days.

## One-time setup

1. **age key pair** (on your machine, not on a server):
   ```bash
   age-keygen -o ricotdin-backup.key      # prints "Public key: age1…"
   ```
   Keep **two independent offline copies** of `ricotdin-backup.key` (e.g. password manager + an
   encrypted USB stored elsewhere) and write down who else can reach it if you can't. Without it,
   no backup can be restored. Never put it in GitHub or on the home server.
2. **R2 bucket** (Cloudflare dashboard → R2): create `ricotdin-db-backups` (separate from the
   audio bucket). Create an **API token** with *Object Read & Write* scoped to **that bucket only**.
3. **Supabase connection string:** Project Settings → Database → Connection string → **Session pooler**
   (`postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`).
   GitHub runners have no IPv6, so the direct connection does not work. Use port **5432** (session
   mode), never the transaction pooler on 6543. **URL-encode** the password if it has special characters.
   The app never uses this password (it uses the service-role key), so rotating it touches only this secret.
4. **GitHub Environment + secrets:** repo → Settings → Environments → **New environment `backup`** →
   *Deployment branches and tags*: **Selected branches → `main` and `dev`** (`schedule` runs from the
   default branch `dev`, CLAUDE.md §9k). Add these as **environment secrets**
   (not repository secrets), so workflows on other branches can't read them:

   | Secret | Value |
   |---|---|
   | `SUPABASE_DB_URL` | Session pooler string from step 3 |
   | `AGE_RECIPIENT` | the `age1…` public key from step 1 |
   | `R2_BACKUP_ACCOUNT_ID` | Cloudflare account id |
   | `R2_BACKUP_ACCESS_KEY_ID` / `R2_BACKUP_SECRET_ACCESS_KEY` | from the scoped token |
   | `R2_BACKUP_BUCKET` | `ricotdin-db-backups` |
5. Recommended: branch protection on `main` (PR + review required) and CODEOWNERS on `.github/workflows/**`,
   so nobody can change what runs with these secrets without review.
6. Run it once: `gh workflow run backup.yml --ref dev` (or *Actions → db-backup → Run workflow* on `dev`); check the object appears in the
   bucket. Optionally add an R2 lifecycle/bucket-lock rule on `db/` (~30 days) as a second line of defence.

## Restore

Restore into a **new, empty Supabase project** first (never straight over production).

```bash
# 1. Download the backup from the R2 dashboard (or any S3 client) → backup.tar.gz.age
# 2. Decrypt + unpack
age -d -i ricotdin-backup.key -o backup.tar.gz backup.tar.gz.age
tar xzf backup.tar.gz            # → roles.sql schema.sql data.sql
# 3. Restore (Session pooler string of the TARGET project)
psql --single-transaction --variable ON_ERROR_STOP=1 \
  --file roles.sql \
  --file schema.sql \
  --command 'SET session_replication_role = replica' \
  --file data.sql \
  --dbname "$TARGET_DB_URL"
# 4. Check row counts against the source (or the dump time)
psql "$TARGET_DB_URL" -c "select (select count(*) from meetings) meetings,
  (select count(*) from transcript_segments) segments, (select count(*) from profiles) profiles;"
```

Notes: the target string must be the Session pooler or a direct connection (not port 6543). "role already
exists" errors from `roles.sql` mean the target project is not empty.

Then re-apply project settings that are not in the dump (CLAUDE.md §9a: custom access token hook,
email/SMTP, anonymous sign-ins off). Delete the decrypted files afterwards.

## Secret rotation

| Secret | When | How |
|---|---|---|
| R2 backup token | yearly, and immediately on suspected exposure | create new token → update `R2_BACKUP_ACCESS_KEY_ID` / `R2_BACKUP_SECRET_ACCESS_KEY` → *Run workflow* → revoke the old token |
| Postgres password | yearly, on exposure, or when a collaborator leaves | Supabase dashboard → update `SUPABASE_DB_URL` → *Run workflow* |
| age key pair | only on suspected compromise | new key pair → new `AGE_RECIPIENT`; keep the old private key 30 days (older backups need it), then destroy it |

Follow-up (least privilege, not required): a read-only role (`LOGIN BYPASSRLS` + `pg_read_all_data`) instead
of `postgres` for the dump — verify it covers `auth` tables before switching.

## Restore-test log

Test restore **once now, then quarterly**, and after any key rotation or Supabase major upgrade — always with
the stored private key (that proves the key works, not just the pipeline).

| Date | Backup object | Target project | meetings / segments / profiles (source → restored) | Result |
|---|---|---|---|---|
| | | | | |
