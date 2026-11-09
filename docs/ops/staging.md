# Staging (OPS-02): one-time setup and use

Staging runs v2 at **https://ricotdin-staging.mmlabs.online**, with the API at
**https://ricotdin-staging-api.mmlabs.online**, on the home server next to production and v1.
Pushing a branch `staging/X.Y.Z` deploys it:

```
push staging/X.Y.Z (ricotdin)
  → release-staging.yml: guard (branch = both version files) → ci-api + ci-web
  → images mingming21400/ricotdin-api|web:staging-X.Y.Z-<sha7>
  → PR "ricotdin staging-X.Y.Z-<sha7>" on mmlabs-online/deployment
    (only apps/ricotdin-v2-staging/release.env, auto-merge)
  → pr-scope passes → merged → deploy-ricotdin-v2-staging.yml on mmlabs-server
  → healthy: comment "deployed" · unhealthy: previous release restored, run red
```

Decisions (owner, 2026-11-09):
- Staging uses the **Neon dev branch** of the owner's local `app/api/.env`, so the local machine
  and staging share the database, the Drive folder and the job queue.
- **No access gate.** Instead there is **no SMTP**, so nobody can register; sign in with an
  account that already exists in the dev database.
- v1 (`apps/ricotdin`) is not touched.

Every step that handles a secret is the owner's. Values never go into a repository, an issue or a
chat.

## One-time setup

| # | Step | Done when |
|---|---|---|
| 1 | **Docker Hub:** create the public repos `mingming21400/ricotdin-api` and `mingming21400/ricotdin-web`. The ricotdin secret `DOCKERHUB_TOKEN` must be able to push to both. | both repos listed |
| 2 | **`DEPLOY_REPO_TOKEN`** (ricotdin secret, already set): a fine-grained PAT on `mmlabs-online/deployment` with **Contents** and **Pull requests** read/write. If it has expired, create a new one. | `gh secret list` shows a recent date |
| 3 | **Deployment repo settings:** turn on *Allow auto-merge* and *Allow squash merging*. Protect `main` with a rule that **requires the `pr-scope` check**: without a required check, auto-merge merges at once. | settings saved |
| 4 | **Copy the drafts** from `docs/ops/deployment-repo/` in a PR on the deployment repo: `apps/ricotdin-v2-staging/compose.yml` and `.github/workflows/deploy-ricotdin-v2-staging.yml`. That PR touches `.github/`, so pr-scope does not apply: review it yourself and merge. | merged |
| 5 | **Logins:** the dev branch's three logins are in your local `app/api/.env` (`DATABASE_URL_APP` / `_SERVICE` / `_WORKER`). If they are missing, run `cd app/api; uv run --env-file .env python -m scripts.provision_db_roles` once. **Re-running it later rotates them, and staging stops** until step 6 is redone. | three URLs present |
| 6 | **Server env files** (on mmlabs-server, owned by the runner user, `chmod 600`): `/etc/mmlabs/ricotdin-staging-api.env`, `-worker.env`, `-web.env`. Contents: see "v2 staging" in `docs/ops/deployment-repo/README.md`. The JWT key for staging: run `cd app/api; uv run python -m scripts.gen_jwt_key --env-file <a file outside the repo>`, then move that line to the server file and delete the local file. **No `SMTP_*`.** | files exist, 600 |
| 7 | **cloudflared:** add `ricotdin-staging.mmlabs.online` → `http://ricotdin-staging-web:8080` and `ricotdin-staging-api.mmlabs.online` → `http://ricotdin-staging-api:8000`. Drop query strings for `/media` from the logs. | both names resolve |
| 8 | **Database:** the dev branch is at the newest migration: `cd app/api; uv run --env-file .env alembic upgrade head`. | `alembic current` = head |

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
push gives a new `<sha7>`. A newer push cancels a release run that is still going.

## When something goes wrong

- **Guard fails:** the branch is not `staging/X.Y.Z` (X ≥ 2), or a version file differs. Fix it on
  `dev` and cut again.
- **The deployment PR stays open:** pr-scope failed, or auto-merge is off (step 3).
- **Deploy is red with "restored":** the new build was unhealthy; the previous one is running
  again. Read the run log: the containers' logs are on the server
  (`docker compose -p ricotdin-v2-staging logs api`).
- **`env-missing`:** step 6. Then *Actions → deploy-ricotdin-v2-staging → Run workflow*.
- **API answers 503 on sign-in:** `JWT_PRIVATE_KEY` is missing in the api env file.
- **Everything 500s after a local `provision_db_roles`:** the logins rotated (step 5 and step 6).
