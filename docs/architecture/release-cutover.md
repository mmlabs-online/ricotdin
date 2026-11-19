> Moved from CLAUDE.md §0.11 (ARC-19). Rules here are binding.

### 0.11 v2 release, supply chain, backup, cutover (ARC-15)

- **`release.yml` (ARC-15; trigger and deploy changed by OPS-09, owner decision 2026-11-17):** a push
  of a new branch `release/X.Y.Z[-pre]` (X ≥ 2). The tag is the branch name: the guard creates
  `vX.Y.Z` with `GITHUB_TOKEN` when it does not exist yet (an existing tag = no release; a tag pushed
  by the workflow does not start it again); the version files are not checked. Then it
  reuses `ci-api.yml` + `ci-web.yml` (`workflow_call`), builds `mingming21400/ricotdin-api`
  (API **and** worker: one image, the worker is `command: python -m app.worker`) and
  `mingming21400/ricotdin-web`, opens the deployment PR writing `RICOTDIN_API_IMAGE`,
  `RICOTDIN_WEB_IMAGE` (both `:tag@digest`) and `RICOTDIN_VERSION` to
  `apps/ricotdin-v2/release.env` (the folder name dates from when v1 still had `apps/ricotdin/`;
  v1 is retired, ARC-20). The PR branch
  is `release/ricotdin-v2-vX.Y.Z`: the deployment repo's `pr-scope.yml` reads the app folder from
  `^release/([a-z0-9-]+)-v[0-9]`, so the branch name decides which `apps/<folder>/` a release PR may
  change (OPS-02 fixed `release/ricotdin-vX.Y.Z`, read as v1's folder). **OPS-09:** the workflow
  then merges that PR at once with `DEPLOY_REPO_TOKEN`, which starts `deploy-ricotdin-v2` there, so the
  branch push is the production deploy; only when the tag is the highest plain version (an older
  line's PR stays open, never an automatic rollback). A prerelease (`release/2.2.0-rc1`) only pushes
  images, no deployment PR.
- **One environment (ARC-20, owner decision 2026-11-12):** production only. The v2 staging
  environment (OPS-02: `release-staging.yml`, `staging/X.Y.Z` branches, `apps/ricotdin-v2-staging/`)
  and v1 are retired; Neon is no longer used. Production = `https://ricotdin.mmlabs.online` (web) +
  `https://ricotdin-api.mmlabs.online` (API), one-level names because the free Cloudflare certificate
  covers `*.mmlabs.online` only, on the self-hosted `macbook-runner` (the MacBook). Database `ricotdin`
  on the shared self-hosted Postgres (§0.1, `docs/ops/self-hosted-postgres.md`), started empty: no
  v1 or staging data carried over. Migrations run in the deploy itself (pg_dump, then `alembic upgrade head`) before any container is replaced. A
  v1 tag fails the guard.
- **Pinning:** every GitHub Action by commit SHA (`# vN` comment), the v2 base images
  (`python`, `node`, `nginx-unprivileged`, `uv`) by digest. Dependabot is off (owner decision
  2026-11-09: no `.github/dependabot.yml`); pins are moved by hand. Python stays on 3.12 until
  `pyproject.toml` (`requires-python`, ruff/mypy target) and `uv.lock` move with it — a base-image
  bump alone breaks the API image (`uv sync` finds no 3.12). Never add an action by tag.
- **Secrets scan:** `.gitleaks.toml` (default rules; allowlist = named test files with fake keys + one
  type annotation — add a file only after checking its "secret" is fake) + `secrets-scan.yml` (gitleaks 8.30.0 binary, sha256-checked: the tree and the new
  commits of every PR/push) + `.pre-commit-config.yaml` (`pre-commit install`). Older history is
  not rescanned: a finding there is rotated at the provider, never allowlisted.
- **Backup (ARC-20, replaces the `backup.yml` of OPS-03 / ARC-15):** the shared Postgres's
  `pg-backup` sidecar dumps `ricotdin` nightly, a LaunchAgent syncs the dumps offsite (rclone, R2),
  and `ops/backup/restore-test.sh ricotdin` proves a restore (all in the deployment repo). Roles and
  logins are not in the dump (migrations + `provision_db_roles`). Runbook `docs/ops/backup-restore.md`.
- **Deployment (copies in `docs/ops/deployment-repo/`, source of truth = the deployment repo):**
  `apps/ricotdin-v2/compose.yml` (api + worker + web + autoheal; aliases `ricotdin-api` /
  `ricotdin-web` on `web`; api + worker on `db` for `postgres:5432`) and `deploy-ricotdin-v2.yml`
  (both pins must be `ricotdin-{api,web}:<RICOTDIN_VERSION>@sha256:…`, v2+; env files
  `/Users/mingming/.config/ricotdin/{api,worker,web}.env` written from the `RICOTDIN_*` repository
  secrets (no JWT or SMTP secrets since AUT-06); restore + revert on unhealthy).
- **Go-live runbook:** `docs/ops/go-live.md` (retire staging, production secrets, tag `v2.0.0`,
  migrations + logins, Cloudflare hostnames, deploy, first admin, Google Drive, provider keys).
- **Known history finding (2026-11-05):** commits of 2026-06-09/10/13 (`README.md`, on `main` and
  `release/1.0`/`1.1`) contain a Supabase `service_role` JWT, the anon JWT and a Gemini API key.
  The Supabase keys die with the Supabase project (shut down by the owner, ARC-16; no final backup,
  owner decision 2026-11-19); delete the Gemini key at Google (roadmap Now 1). History is not rewritten.
