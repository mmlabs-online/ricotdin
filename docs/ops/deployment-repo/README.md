# ricotdin in mmlabs-online/deployment (OPS-05, ARC-20)

ricotdin has one deployment: v2 production. v1 and the v2 staging environment are retired
(2026-11-12). The deployment repository is the source of truth; this folder keeps copies so a
ricotdin change can be reviewed next to them. Keep them identical.

| Copy here | In the deployment repo |
|---|---|
| `apps/ricotdin-v2/compose.yml` | same path |
| `.github/workflows/deploy-ricotdin-v2.yml` | same path |

Also in the deployment repo: the shared Postgres (`postgres/`, database `ricotdin`, superuser extras
`postgres/sql/apps/ricotdin.sql`), backups (`ops/backup/`), cloudflared (`proxy/`).

## Shape

- **Containers** (project `ricotdin-v2`): `api` (FastAPI) and `worker` (pipeline) from
  `mingming21400/ricotdin-api`, `web` (nginx + SPA) from `mingming21400/ricotdin-web`, and an
  `autoheal` that restarts only containers labelled `autoheal-ricotdin=true`. No published ports.
- **Networks:** `web` (cloudflared) for api + web; `db` (internal) for api + worker to reach
  `postgres:5432`; the worker's `default` network for outbound calls (Google Drive, AI / speech providers).
- **Hostnames:** `ricotdin.mmlabs.online` → `http://ricotdin-web:8080`,
  `ricotdin-api.mmlabs.online` → `http://ricotdin-api:8000`. They are one level deep because the free
  Cloudflare certificate covers `*.mmlabs.online` only.

## How a release deploys

```
tag vX.Y.Z on release/X.Y (ricotdin) → release.yml: CI → build + push both images
  → PR "ricotdin vX.Y.Z" on the deployment repo, branch release/ricotdin-v2-vX.Y.Z,
    writes ONLY apps/ricotdin-v2/release.env (both images by digest + RICOTDIN_VERSION)
run that release's `alembic upgrade head` on the Mac   ← BEFORE merging (docs/ops/self-hosted-postgres.md)
merge the PR → deploy-ricotdin-v2 (runner macbook-runner):
  check release.env → write env files from secrets → pull → up -d --wait (180 s)
  healthy → PR comment "deployed"   ·   unhealthy → restore the previous release.env, redeploy it,
  push the revert, comment "restored"
```

A restore never touches the database, so every migration must stay compatible with the previous
release's image. `pr-scope.yml` limits a `release/ricotdin-v2-v…` PR to `apps/ricotdin-v2/`.

## Runtime secrets

They are repository secrets of the deployment repo, one per key, named `RICOTDIN_<KEY>`. Every deploy
run (step `envfile`) rewrites `~/.config/ricotdin/{api,worker,web}.env` (`chmod 600`) from them, so
nobody creates or edits those files by hand. To change a value, run
`gh secret set RICOTDIN_<KEY> -R mmlabs-online/deployment` (it prompts for the value), then
*Actions → deploy-ricotdin-v2 → Run workflow*. A missing required secret fails the run by name before
anything is replaced. Values must be one line without `'`.

- **Required:** `DATABASE_URL_APP`, `DATABASE_URL_SERVICE`, `DATABASE_URL_WORKER` (the `ricotdin`
  logins from `provision_db_roles`, never the owner URL), `JWT_PRIVATE_KEY` (one line, escaped `\n`),
  `KEY_ENCRYPTION_SECRET`.
- **Mail:** reuses org-admin-api's Gmail account. The job declares the GitHub Environment
  `org-admin-api` and writes `SMTP_USER` / `SMTP_PASSWORD` from `ORG_ADMIN_SMTP_USERNAME` /
  `ORG_ADMIN_SMTP_PASSWORD` (spaces stripped); `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465` are fixed in
  the workflow. Rotating that App Password therefore needs a re-run of both deploys.
- **Optional:** `MAIL_FROM` (empty = the Gmail address), `SENTRY_DSN`, `JWT_PREVIOUS_PUBLIC_KEY` (only
  during a key rotation).
- **Not secrets** (committed in the workflow): `WEB_ORIGIN` = `ALLOWED_ORIGINS` =
  `https://ricotdin.mmlabs.online`, and web `RICOTDIN_API_URL` = `https://ricotdin-api.mmlabs.online`.
  No `API_DOCS`.
- **`FORWARDED_ALLOW_IPS` is unset** until cloudflared gets a fixed `ipv4_address` in `proxy/compose.yml`
  (never the whole subnet). Until then uvicorn ignores `X-Forwarded-For`, so all clients share one
  address for the login/register rate limits: safe, just stricter.
- Each file gets only its own service's keys: worker = `DATABASE_URL_WORKER`, `KEY_ENCRYPTION_SECRET`
  (+ `SENTRY_DSN`); web = `RICOTDIN_API_URL`. The worker refuses to start with anything else.
- **Back up `KEY_ENCRYPTION_SECRET` offline** (password manager). Losing it makes every stored provider
  key and the Drive grant unreadable, and a database dump cannot bring them back.

## Security notes

- Repository secrets are readable by **every** workflow in the deployment repo (a private repo on the
  Free plan has no Environments), and write access to it is root on the Mac: the deploy workflows run
  whatever `main` says. Keep collaborators minimal. `DEPLOY_REPO_TOKEN` (ricotdin's release token) must
  not have the *Workflows* permission.
- Values from `env_file` become container environment: `docker inspect` and `docker compose config`
  (without `--quiet`) print them. Never paste that output anywhere.

## Rollback

A PR on the deployment repo that sets `apps/ricotdin-v2/release.env` back to the previous release's
three lines (from git history), merged. That is only safe if no destructive migration ran in between.

## First go-live

`docs/ops/go-live.md`.
