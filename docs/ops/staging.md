# Staging (OPS-02): one-time setup and use

Staging runs v2 at **https://ricotdin-staging.mmlabs.online**, with the API at
**https://ricotdin-staging-api.mmlabs.online**, on the home server next to production and v1.
Pushing a branch `staging/X.Y.Z` deploys it:

```
push staging/X.Y.Z (ricotdin)
  → release-staging.yml: guard (branch = both version files) → ci-api + ci-web
  → images mingming21400/ricotdin-api|web:staging-X.Y.Z-<sha7>
  → PR "ricotdin staging-X.Y.Z-<sha7>" on mmlabs-online/deployment (only apps/ricotdin-v2-staging/release.env)
  → the same run waits for pr-scope, checks the PR changes only that file, merges it
  → deploy-ricotdin-v2-staging.yml on the MacBook runner (macbook-runner)
  → healthy: comment "deployed" · unhealthy: previous release restored, run red
```

Decisions (owner, 2026-11-09):
- Staging uses database `ricotdin` on the shared self-hosted Postgres (ARC-20, 2026-11-12; was the
  Neon dev branch shared with local development). Migrations and logins run on the Mac:
  `docs/ops/self-hosted-postgres.md`. Local development uses its own container database now.
- **No access gate.** Instead there is **no SMTP**, so nobody can complete a registration (the API
  still stores an unverified sign-up, 5 per hour per client); sign in with an account that already
  exists in the dev database. Every dev account is reachable from the internet: give each one a
  strong unique password and remove stale test admins.
- v1 (`apps/ricotdin`) is not touched.

Every step that handles a secret is the owner's. Values never go into a repository, an issue or a
chat.

## One-time setup

| # | Step | Done when |
|---|---|---|
| 1 | **Docker Hub:** create the public repos `mingming21400/ricotdin-api` and `mingming21400/ricotdin-web`. The ricotdin secret `DOCKERHUB_TOKEN` must be able to push to both. | both repos listed |
| 2 | **`DEPLOY_REPO_TOKEN`** (ricotdin secret, already set): a fine-grained PAT on `mmlabs-online/deployment` with **Contents** and **Pull requests** read/write, plus **Actions: read** (the staging run reads the `pr-scope` result through it). If it has expired, create a new one. | `gh secret list` shows a recent date |
| 3 | **Deployment repo settings:** *Allow squash merging* must stay on (it is). The release run waits for `pr-scope` itself and merges only a PR that changes `apps/ricotdin-v2-staging/release.env` alone. **Known limit:** on the GitHub Free plan a private repo has no branch protection, so nothing *forces* that check and `DEPLOY_REPO_TOKEN` could push to `main` directly (true before OPS-02 too). The real fix is GitHub Team (or a public deployment repo) with a protected `main` requiring `pr-scope` + CODEOWNERS, and a GitHub App instead of your PAT: debt issue. | squash merging on |
| 4 | **Copy the drafts** from `docs/ops/deployment-repo/` in a PR on the deployment repo: `apps/ricotdin-v2-staging/compose.yml` and `.github/workflows/deploy-ricotdin-v2-staging.yml`. That PR touches `.github/`, so pr-scope does not apply: review it yourself and merge. | merged |
| 5 | **Logins:** the dev branch's three logins are in your local `app/api/.env` (`DATABASE_URL_APP` / `_SERVICE` / `_WORKER`). If they are missing, run `cd app/api; uv run --env-file .env python -m scripts.provision_db_roles` once. **Re-running it later rotates them, and staging stops** until step 6 is redone. | three URLs present |
| 6 | **Deployment repo secrets** (the deploy run writes the server env files from them; never create those by hand): `RICOTDIN_DATABASE_URL_APP`, `RICOTDIN_DATABASE_URL_SERVICE`, `RICOTDIN_DATABASE_URL_WORKER`, `RICOTDIN_KEY_ENCRYPTION_SECRET`, `RICOTDIN_JWT_PRIVATE_KEY` (optional `RICOTDIN_SENTRY_DSN`). Set each with `gh secret set <NAME> -R mmlabs-online/deployment` (it prompts for the value). The JWT key for staging: `cd app/api; uv run python -m scripts.gen_jwt_key --env-file <a file outside the repo>`, paste that line's value into `RICOTDIN_JWT_PRIVATE_KEY`, then delete the file. Details: "v2 staging" in `docs/ops/deployment-repo/README.md`. **No `SMTP_*`.** | `gh secret list -R mmlabs-online/deployment` shows the five |
| 7 | **cloudflared:** add `ricotdin-staging.mmlabs.online` → `http://ricotdin-staging-web:8080` and `ricotdin-staging-api.mmlabs.online` → `http://ricotdin-staging-api:8000`. Drop query strings for `/media` from the logs. | both names resolve |
| 8 | **Database:** the dev branch is at the newest migration: `cd app/api; uv run --env-file .env alembic upgrade head`. | `alembic current` = head |
| 9 | **Keys of the dev database:** make sure the `KEY_ENCRYPTION_SECRET` in your local `.env` (and so on staging) is **not** the production / v1 value, and that the dev `drive_config` is not connected with the production Google account + OAuth client. Staging is public and runs any pushed `staging/*` branch: whoever reaches it must not get production keys. If they are the same: set a new secret for dev, re-add the dev provider keys at `/admin/keys` and re-run `connect_gdrive`. | different values confirmed |

## Deploy

1. On `dev`, make sure `app/api/pyproject.toml` and `app/web/package.json` hold the version you
   stage (now `2.0.0`). The guard refuses any mismatch.
2. If the commit brings a new Alembic revision, run step 8 first: a deploy never migrates.
3. Cut the branch and push it:
   `git checkout dev; git pull; git checkout -b staging/2.0.0; git push -u origin staging/2.0.0`.
4. Watch *Actions → Release staging* in ricotdin, then *Actions → deploy-ricotdin-v2-staging* in
   the deployment repo. The PR there gets a "deployed" comment.
5. Check: `https://ricotdin-staging-api.mmlabs.online/version.json` shows
   `staging-2.0.0-<sha7>`; sign in at `https://ricotdin-staging.mmlabs.online`.

To redeploy, push to the same branch (a fix, or `git commit --allow-empty -m "redeploy"`). Each
push gives a new `<sha7>`. A newer push cancels a release run that is still going, and re-running an
older run deploys nothing (it is no longer the branch head). Keep **one staging branch at a time**:
two open `staging/*` branches race for the same `release.env`.

**Shared with local development:** the job queue (a local worker and the staging worker take each
other's jobs; stop the local worker while you test staging), the scheduler leases, and the Drive
folder. **Never set `storage.audio_retention_days` on the dev database:** the purge would delete
shared Drive files for good. Run `alembic upgrade head` only together with a staging push: an older
staging image may not run on a newer schema.

## When something goes wrong

- **Guard fails:** the branch is not `staging/X.Y.Z` (X ≥ 2), or a version file differs. Fix it on
  `dev` and cut again.
- **The deployment PR stays open, release run red:** pr-scope failed, it took over 10 minutes (merge
  it by hand once green), or the PR changed more than `release.env`.
- **Deploy is red with "restored":** the new build was unhealthy; the previous one is running
  again. Read the run log: the containers' logs are on the server
  (`docker compose -p ricotdin-v2-staging logs api`).
- **`env-missing`:** the run log names the missing or malformed `RICOTDIN_*` secret (step 6). Set it,
  then *Actions → deploy-ricotdin-v2-staging → Run workflow*.
- **API answers 503 on sign-in:** `RICOTDIN_JWT_PRIVATE_KEY` is wrong (it is required, so it is not missing).
- **Everything 500s after a local `provision_db_roles`:** the logins rotated: set the three URL
  secrets again (step 6) and Run workflow.
