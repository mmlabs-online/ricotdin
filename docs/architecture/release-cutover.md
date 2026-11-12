> Moved from CLAUDE.md §0.11 (ARC-19). Rules here are binding.

### 0.11 v2 release, supply chain, backup, cutover (ARC-15)

- **`release.yml` is v2 from `dev` on:** tag `vX.Y.Z` (X ≥ 2) on `release/X.Y`; the guard job
  requires the same version in `app/api/pyproject.toml` and `app/web/package.json` (bump both),
  then reuses `ci-api.yml` + `ci-web.yml` (`workflow_call`), builds `mingming21400/ricotdin-api`
  (API **and** worker: one image, the worker is `command: python -m app.worker`) and
  `mingming21400/ricotdin-web`, and opens the deployment PR writing `RICOTDIN_API_IMAGE`,
  `RICOTDIN_WEB_IMAGE` (both `:tag@digest`) and `RICOTDIN_VERSION` to
  `apps/ricotdin-v2/release.env` — its own app directory, because v1 hotfix releases rewrite all of
  `apps/ricotdin/release.env` and v1's deploy workflow fires on `apps/ricotdin/**`. The PR branch
  is `release/ricotdin-v2-vX.Y.Z`: the deployment repo's `pr-scope.yml` reads the app folder from
  `^release/([a-z0-9-]+)-v[0-9]`, so the branch name decides which `apps/<folder>/` a release PR may
  change (OPS-02 fixed `release/ricotdin-vX.Y.Z`, read as v1's folder). A prerelease
  tag (`v2.0.0-rc1`) only pushes images, no deployment PR.
- **Staging (OPS-02, `docs/ops/staging.md`):** pushing `staging/X.Y.Z` (X ≥ 2) runs
  `release-staging.yml` (`shell: bash`): guard `python3 -I app/ops/staging_release.py` (a file:
  `-I` implies `-P` since 3.11; stdlib only; branch = both version files; it appends its outputs to
  `$GITHUB_OUTPUT` only on success), both CI suites, images `:staging-X.Y.Z-<sha7>` (never `latest`
  or `vX.Y.Z`), then a PR from `release/ricotdin-v2-staging-vX.Y.Z` writing only
  `apps/ricotdin-v2-staging/release.env`; the same run waits for `pr-scope`, checks the PR changes
  only that file and squash-merges it. Not GitHub auto-merge: a private repo on the Free plan has no
  branch protection, so nothing enforces the check (debt). Only the branch head deploys (an old
  re-run is skipped); one staging branch at a time. `deploy-ricotdin-v2-staging.yml` deploys it on
  the self-hosted `macbook-runner` (the MacBook; mmlabs-server is retired; env files in
  `/Users/mingming/.config/ricotdin-staging/`, production v2 `/Users/mingming/.config/ricotdin/`) with
  restore on unhealthy.
  Hosts `ricotdin-staging.mmlabs.online` (web) + `ricotdin-staging-api.mmlabs.online` (one-level
  names: the free Cloudflare certificate covers `*.mmlabs.online` only). Staging = database `ricotdin`
  on the shared self-hosted Postgres through the three app logins (ARC-20, owner decision
  2026-11-12; was the Neon dev branch; it becomes production at cutover, see
  `docs/ops/self-hosted-postgres.md`; re-running `provision_db_roles` rotates them and stops staging),
  no `SMTP_*` (nobody can complete a registration), no access gate, its own autoheal label; never
  the production `KEY_ENCRYPTION_SECRET`, JWT key or Google client on the dev branch (staging is
  public and runs any pushed `staging/*` branch); never set `storage.audio_retention_days` on dev
  (the shared Drive folder). Never migrates: the
  owner runs `alembic upgrade head` on dev before pushing a staging branch with a migration.
  Versions are `2.0.0` since OPS-02.
  A v1 tag on `dev` fails the guard; v1 hotfix tags are cut on `release/1.1`, whose own
  `release.yml` still builds v1 (a tag runs the workflow file of the tagged commit).
- **Pinning:** every GitHub Action by commit SHA (`# vN` comment), the v2 base images
  (`python`, `node`, `nginx-unprivileged`, `uv`) by digest. Dependabot is off (owner decision
  2026-11-09: no `.github/dependabot.yml`); pins are moved by hand. Python stays on 3.12 until
  `pyproject.toml` (`requires-python`, ruff/mypy target) and `uv.lock` move with it — a base-image
  bump alone breaks the API image (`uv sync` finds no 3.12). Never add an action by tag.
- **Secrets scan:** `.gitleaks.toml` (default rules; allowlist = named test files with fake keys + one
  type annotation — add a file only after checking its "secret" is fake) + `secrets-scan.yml` (gitleaks 8.30.0 binary, sha256-checked: the tree and the new
  commits of every PR/push) + `.pre-commit-config.yaml` (`pre-commit install`). Older history is
  not rescanned: a finding there is rotated at the provider, never allowlisted.
- **Backup (part 2) replaces v1 OPS-03 — superseded by ARC-20:** the shared Postgres's `pg-backup`
  sidecar dumps `ricotdin` nightly and syncs it offsite (deployment repo `ops/backup/`). Remove
  `backup.yml` + secret `NEON_BACKUP_DATABASE_URL` once Neon is retired. Was: `backup.yml` dumps Neon `main` with pg_dump 18
  (`--format=custom`, secret `NEON_BACKUP_DATABASE_URL`: a `BYPASSRLS` + `pg_read_all_data` login —
  pg_dump fails on RLS tables without BYPASSRLS — direct URL), checks the archive lists
  `public.meetings`, age-encrypts it; a second job that never sees the DB secret installs packages
  (artifact = the encrypted file only) and `scripts/backup_r2.py` uploads `db-v2/ricotdin-v2-db-<UTC>.dump.age` (IfNoneMatch)
  and prunes after 30 days (`app/ops/backup_plan.py`, pure, tests `test_backup_plan.py`; never the
  newest, never v1's `db/` keys). Roles/logins are not in the dump (migrations +
  `provision_db_roles`). Runbook `docs/ops/backup-restore.md`. The v1 `SUPABASE_DB_URL` secret is
  retired; the final v1 dump is taken by hand at the cutover. §9o describes the retired v1 job.
- **Deployment (drafts in `docs/ops/deployment-repo/`):** `apps/ricotdin-v2/compose.yml` (api +
  worker + web + autoheal, network aliases `ricotdin-api` / `ricotdin-web` on `web`, three server
  env files `/etc/mmlabs/ricotdin-{api,worker,web}.env`) and `deploy-ricotdin-v2.yml` (both pins
  must be `ricotdin-{api,web}:<RICOTDIN_VERSION>@sha256:…`; restore on unhealthy like v1). v1's
  `apps/ricotdin/` stays for the rollback until ARC-16.
- **Cutover runbook:** `docs/ops/v2-cutover.md` (prep table incl. the staging rehearsal + rollback
  test, the window: stop v1 → final v1 dump → final migration → go-live counts → tag `v2.0.0` →
  deploy → switch cloudflared hostnames → smoke checklist; rollback; after go-live).
- **Known history finding (2026-11-05):** commits of 2026-06-09/10/13 (`README.md`, on `main` and
  `release/1.0`/`1.1`) contain a Supabase `service_role` JWT, the anon JWT and a Gemini API key.
  Rotate them (Supabase: JWT secret rotation / new API keys; Google: delete the key); history is
  not rewritten.
