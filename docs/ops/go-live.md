# ricotdin production go-live (ARC-20)

**Owner:** project owner. One-time steps to put v2 live as the only ricotdin, on
`https://ricotdin.mmlabs.online` (web) + `https://ricotdin-api.mmlabs.online` (API), with an empty
database `ricotdin` on the shared Postgres. v1, the v2 staging environment and Neon are retired;
no data is carried over (owner decision 2026-11-12). Database details:
`docs/ops/self-hosted-postgres.md`. Later releases: steps 3, 5 and 6 only (§9k in `CLAUDE.md`).

Every command below runs **on the Mac** (the self-hosted runner) unless it says otherwise.

## 1. Retire staging

1. Stop the staging containers. Leave out `-v`: never delete Docker volumes on this server.
   ```bash
   docker compose -p ricotdin-v2-staging down
   ```
2. Cloudflare Zero Trust → Networks → Tunnels → the `proxy/` tunnel → *Public hostnames*: delete
   `ricotdin-staging.mmlabs.online` and `ricotdin-staging-api.mmlabs.online`.
3. Remove the old staging env folder:
   ```bash
   rm -rf ~/.config/ricotdin-staging
   ```

## 2. Production secrets (deployment repo)

The deploy writes `~/.config/ricotdin/{api,worker,web}.env` from the repository secrets
`RICOTDIN_*` on every run. Staging's values were public test values: **replace every one**. Set
each with `gh secret set <NAME> -R mmlabs-online/deployment`; it prompts for the value, so nothing
lands in shell history.

| Secret | Value |
|---|---|
| `RICOTDIN_KEY_ENCRYPTION_SECRET` | a new `openssl rand -hex 32`. Also keep it in a password manager: losing it makes every stored provider key and the Drive grant unreadable |
| `RICOTDIN_JWT_PRIVATE_KEY` | a new key: in a ricotdin checkout, `cd app/api && uv run python -m scripts.gen_jwt_key --env-file /tmp/jwt.env`, paste the value of its `JWT_PRIVATE_KEY` line, then `rm /tmp/jwt.env` |
| `RICOTDIN_DATABASE_URL_APP` / `_SERVICE` / `_WORKER` | from `provision_db_roles`, step 4 |
| `RICOTDIN_SMTP_HOST`, `RICOTDIN_SMTP_USER`, `RICOTDIN_SMTP_PASSWORD`, `RICOTDIN_MAIL_FROM` | the production mail account (registration and password-reset links) |
| `RICOTDIN_SMTP_PORT` | optional, default 465 (implicit TLS) |
| `RICOTDIN_SENTRY_DSN` | optional |

Delete `RICOTDIN_JWT_PREVIOUS_PUBLIC_KEY` if staging left one (`gh secret delete … -R mmlabs-online/deployment`).

## 3. Release v2.0.0 (ricotdin repo, `CLAUDE.md` §9k)

Both version files already say `2.0.0`. On `dev`:
1. Rename `## [Unreleased]` in `CHANGELOG.md` to `## [2.0.0] — <date>`.
2. Commit `chore(release): v2.0.0`, then PR `dev` → `main` with `--base main`, and merge it (merge commit).
3. Cut the branch and tag:
   ```bash
   git checkout main && git pull && git checkout -b release/2.0 && git push -u origin release/2.0
   ```
   ```bash
   git tag -a v2.0.0 -m "Release v2.0.0" && git push origin v2.0.0
   ```
4. `release.yml` builds `mingming21400/ricotdin-api:v2.0.0` and `ricotdin-web:v2.0.0` and opens
   PR `ricotdin v2.0.0` on the deployment repo. **Do not merge it yet.**

## 4. Database

Use the API image pinned in that PR (`apps/ricotdin-v2/release.env`), as in
`docs/ops/self-hosted-postgres.md`:
1. `alembic upgrade head` (empty database → all migrations).
2. `provision_db_roles`, then set the three `RICOTDIN_DATABASE_URL_*` secrets.

## 5. Cloudflare hostnames

The `proxy/` tunnel → *Public hostnames*:
- `ricotdin.mmlabs.online` → `http://ricotdin-web:8080`
- `ricotdin-api.mmlabs.online` → `http://ricotdin-api:8000`

Keep `/media` query strings out of the logs (signed, short-lived media URLs).

## 6. Deploy

Merge PR `ricotdin v2.0.0`. `deploy-ricotdin-v2` writes the env files, starts api + worker + web
and waits until they are healthy. The PR then gets a `deployed` comment, or `env-missing` with the
names of missing secrets. Check:
```bash
curl -fsS https://ricotdin-api.mmlabs.online/health
```
```bash
curl -fsS https://ricotdin-api.mmlabs.online/version.json
```

## 7. First admin, Google Drive, provider keys

1. Register at `https://ricotdin.mmlabs.online` and verify the email.
2. Make that account admin. As the superuser, run this once (`sync_profile_role` copies the role to
   `profiles`):
   ```bash
   docker compose -p postgres -f ~/srv/postgres/compose.yml exec postgres psql -U postgres -d ricotdin -c "UPDATE public.users SET role = 'admin' WHERE lower(email) = lower('<your email>')"
   ```
   Sign out and in again.
3. Connect Google Drive. The script needs a browser on the Mac, the internet and `postgres:5432`,
   so run it from a ricotdin checkout on the Mac. It reaches the database through a temporary local
   tunnel:
   ```bash
   docker create --name ricotdin-pg-tunnel -p 127.0.0.1:15432:5432 alpine/socat:1.8.0.3 tcp-listen:5432,fork,reuseaddr tcp-connect:postgres:5432
   ```
   ```bash
   docker network connect db ricotdin-pg-tunnel && docker start ricotdin-pg-tunnel
   ```
   Put `DATABASE_URL_APP`, `DATABASE_URL_SERVICE`, `DATABASE_URL_WORKER` (the three secret values
   with `@postgres:5432` replaced by `@127.0.0.1:15432`) and `KEY_ENCRYPTION_SECRET` in a 0600 file
   `/tmp/ricotdin-drive.env`, outside the repo. Then, in `app/api`:
   ```bash
   uv run --env-file /tmp/ricotdin-drive.env python -m scripts.connect_gdrive --folder ricotdin
   ```
   ```bash
   uv run --env-file /tmp/ricotdin-drive.env python -m scripts.drive_smoke
   ```
   ```bash
   rm /tmp/ricotdin-drive.env && docker rm -f ricotdin-pg-tunnel
   ```
4. Add the AI / speech provider keys at `/admin/keys`.

## 8. Afterwards (irreversible, owner confirms each)

- Delete the Neon project `ricotdin-sg`.
- Shut down the v1 Supabase project after its final backup (ARC-16).
- Install rclone on the Mac and finish the offsite backup setup (deployment repo
  `ops/backup/RESTORE.md`). Until then only the local nightly dumps exist.

## Rollback

A deployment PR that sets `apps/ricotdin-v2/release.env` back to the previous release's three lines,
only safe if no destructive migration ran in between. The automatic restore covers "the new image
is unhealthy". A broken database is restored from the nightly dump (deployment repo
`ops/backup/RESTORE.md`).
