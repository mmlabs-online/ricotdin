# v1 → v2 cutover and v2.0.0 release (ARC-15)

**Owner:** project owner. Read the whole page before the window.

Supabase and the v1 container are **never changed**, so going back to v1 stays possible until
ARC-16. Commands run from `app/api` unless noted.

Related runbooks:
- data migration: `docs/ops/v2-migration-rehearsal.md`;
- backups: `docs/ops/backup-restore.md`;
- deployment repo: `docs/ops/deployment-repo/README.md`.

## Before the window (days ahead)

| # | Step | Done when |
|---|---|---|
| 1 | Rotate the keys found in git history (CLAUDE.md §0.11): the Supabase service_role + anon keys, and the Gemini key starting `AQ.A`. | old keys rejected |
| 2 | Two migration rehearsals that PASS **with the Drive copy** (rehearsal log). | log rows 2 + 3 filled |
| 3 | Neon `main`, as the owner: `uv run --env-file .env.prod-owner alembic upgrade head`. | revision = head |
| 4 | Production logins: `uv run --env-file .env.prod-owner python -m scripts.provision_db_roles --env-file .env.prod-logins`. Copy the `DATABASE_URL_APP`, `DATABASE_URL_SERVICE` and `DATABASE_URL_WORKER` values into `/Users/mingming/.config/ricotdin/api.env`, and only `DATABASE_URL_WORKER` into `ricotdin-worker.env`. Then delete `.env.prod-logins`. | files on the server, `chmod 600` |
| 5 | Production Drive folder: `connect_gdrive --folder ricotdin` with `DATABASE_URL_SERVICE` of `main`, then `drive_smoke`. Write down the **folder id**. | smoke ok |
| 6 | API env file: `JWT_PRIVATE_KEY` (generate it on the server), `KEY_ENCRYPTION_SECRET` (the v1 value), the SMTP app password of a **dedicated** account, `MAIL_FROM`, `WEB_ORIGIN` = `ALLOWED_ORIGINS` = `https://app.<domain>`, `FORWARDED_ALLOW_IPS`, `SENTRY_DSN`. Never `API_DOCS=1`. | `docker compose config --quiet` ok |
| 7 | Docker Hub repos `ricotdin-api` + `ricotdin-web`. Deployment repo PR with the drafts: `apps/ricotdin-v2/compose.yml`, `deploy-ricotdin-v2.yml`, and `pr-scope.yml` accepting `apps/ricotdin-v2/release.env` + dismissing stale approvals. | merged |
| 8 | Backup environment secrets (`backup-restore.md`, one-time setup). | one manual run green |
| 9 | Release candidate: `app/api/pyproject.toml` and `app/web/package.json` are `2.0.0` since OPS-02 (staging, `docs/ops/staging.md`: rehearse there first); PR `dev → main`, cut `release/2.0`, tag `v2.0.0-rc1` (images only, no deploy PR). | both images on Docker Hub |
| 10 | **Staging rehearsal of this whole runbook** (acceptance criterion; details below), **including the rollback**. | staging log row filled |

### Staging rehearsal

- **Target:** a Neon rehearsal branch, its own `ricotdin-rehearsal` Drive folder, and staging
  hostnames (`app-staging.<domain>`, `api-staging.<domain>`).
- **Stack:** the `rc` images, deployed by hand with
  `docker compose -p ricotdin-v2-staging … up -d --wait`. Use staging env files, never the
  production ones.
- **Run:** the window steps below, end to end. Then run the rollback (point the staging hostnames
  back to v1) and time it.
- **Clean up:** delete the branch, the folder and the staging containers.

## The window

Pick a quiet time and tell users the window (≈ 1 h, v1 unavailable).

1. **Stop v1 writes.** v1 has no read-only mode, so stop the v1 container:
   `docker compose -p ricotdin -f apps/ricotdin/compose.yml stop`. Supabase stays up and unchanged.
2. **Final v1 dump by hand**, kept offline:
   `pg_dump --dbname "$SUPABASE_DB_URL" --format=custom -f v1-final.dump`.
   Use a pg_dump at least as new as Supabase's Postgres. Encrypt it with `age -r <AGE_RECIPIENT>`,
   then delete the plaintext `v1-final.dump`. The URL shows in `ps` on your machine; use a
   `.pgpass` entry instead of a password in the URL if others share the computer.
3. **Final migration into `main`.** Do this **before v2 accepts any login**: a re-run overwrites
   `users.*`.
   ```bash
   uv run --env-file .env.migrate python -m scripts.migrate_from_supabase \
     --confirm-target <main host> --confirm-drive-folder <production folder id> --report migration-report-final.md
   ```
   - It must say **PASS**: 100 % tables, embeddings and secrets, and no file failure.
   - Accept every "missing at source" and "rejected" file it lists.
4. **Go-live counts on `main`.** Write them down and accept them.
   - Meetings left on v1:
     `SELECT count(*) FROM meetings WHERE audio_path IS NOT NULL AND storage_provider <> 'gdrive';`
   - Wallet drift, which the worker's first `wallet_reconcile` will rewrite:
     ```sql
     SELECT count(*) FROM quota_wallets w
     LEFT JOIN (SELECT user_id, sum(delta_audio_seconds) a, sum(delta_agent_queries) q
                FROM quota_ledger GROUP BY user_id) l USING (user_id)
     WHERE w.audio_seconds_remaining <> coalesce(l.a, 0)
        OR w.agent_queries_remaining <> coalesce(l.q, 0);
     ```
   - Migrated meetings still `processing` (the worker's `stuck_meetings` task fails them on its
     first run, with the timeout message):
     `SELECT count(*) FROM meetings WHERE status = 'processing';`
5. **Release:**
   - PR `release/2.0` ← `main` if needed;
   - tag `v2.0.0` → the `Release` workflow → the deployment PR `ricotdin v2.0.0`;
   - merge it → `deploy-ricotdin-v2` comments **deployed** (api, worker, web and autoheal are
     healthy).
   - The worker starts only now, after the file copy (CLAUDE.md §0.7, ARC-15 ordering).
6. **Switch traffic.** In cloudflared:
   - `app.<domain>` → `http://ricotdin-web:8080`;
   - `api.<domain>` → `http://ricotdin-api:8000`;
   - the old v1 hostname → a redirect to `https://app.<domain>`.
7. **Verify on production:**
   - `GET https://api.<domain>/health` → 200, and `/version.json` → `{"version":"v2.0.0"}`.
   - The smoke checklist below, in a private window.
   - `/admin/health` shows no error once the worker has run every task. That takes up to 24 h for
     key health; trigger it from `/admin/keys` → *run check*.
8. **Go / no-go:** decide within the window. After v2 has accepted real writes, a rollback loses
   them, because v1 knows nothing written in v2.

### Production smoke checklist

- [ ] Sign in with a real migrated v1 account. The password works; afterwards the stored hash is
      argon2.
- [ ] The meetings list shows the migrated meetings and folders.
- [ ] A migrated meeting opens: summary, notes, transcript, to-dos. The audio plays (Drive) and
      seeking works.
- [ ] Chat about that meeting answers with citations.
- [ ] Record or upload a short file: it goes pending → processing → done. This proves the worker,
      Speechmatics, AI and Drive.
- [ ] As an admin: `/admin/health`, `/admin/pipeline` and `/admin/storage` load. The audit log
      shows the actions taken.
- [ ] Profile: change the avatar.

## Rollback

**Before v2 accepted real writes:**
1. In cloudflared, point the hostnames back to v1 (`http://ricotdin:3000`).
2. Start v1 again: `docker compose -p ricotdin … start`.
3. Stop v2: `docker compose -p ricotdin-v2 -f apps/ricotdin-v2/compose.yml stop`. Reverting
   `release.env` does not stop anything: the deploy workflow then finds nothing to deploy.

Before the next attempt, **reset Neon `main`** to an empty database at head: restore it to a
point before the first final migration, or create a fresh branch and run `alembic upgrade head`.
The migration only upserts, so rows deleted in v1 after the rollback would otherwise survive in
v2. The Drive folder can stay: copied files are compared with their source, never duplicated.

**After real writes:** there is no automatic path back. Either fix forward on v2 (hotfix
`v2.0.x` from `release/2.0`), or accept losing the v2 writes and roll back as above.

## After go-live

- **Done check:** v2.0.0 is live, and the first nightly Neon backup is uploaded (`db-v2/…` in the bucket).
- **Retire the migration credentials:** see "After the cutover" in `v2-migration-rehearsal.md`.
  This covers the Supabase secret key, the `postgres` password, the Neon owner password,
  `.env.migrate` and the rehearsal folders.
- **Audio retention:** set `storage.audio_retention_days` only now (after the file copy), and only
  after confirming at `/admin/config`.
- **Status:** mark ARC-15 done (`tracking.md`, `/admin/features`) and create the GitHub Release
  from `CHANGELOG.md` `[2.0.0]`.
- **Later:** ARC-16, after a stable period, removes `legacy/`, Supabase and the v1 R2 buckets.

## Log

| Date | What (staging rehearsal / rollback test / production) | Migration report | Smoke | Rollback time | Result |
|---|---|---|---|---|---|
| | | | | | |
