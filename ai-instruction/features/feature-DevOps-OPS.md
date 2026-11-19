# DevOps Module (OPS)

**Module prefix:** OPS  
**Status:** ❌ Not started — all three are mandatory for production  
**Priority:** Mandatory for any production deployment

---

## Overview

The DevOps module establishes the automated infrastructure needed to safely deploy and operate the application: CI/CD with automated tests, a staging environment, and database backup. Without these, every deploy is a manual gamble and a single DB incident could be unrecoverable.

---

## Features

### OPS-01 — CI + automated tests
**Status:** ❌ Not started  
**Mandatory:** Yes

**User Story**  
As a developer, I want automated tests to run before deploy to catch bugs early.

**Use Cases**
1. Developer pushes a branch or opens a PR.
2. GitHub Actions (or equivalent CI) triggers automatically.
3. CI runs: type checking (`tsc --noEmit`), linting (`npm run lint`), and tests (`npm run test`).
4. If any step fails, the PR is blocked from merging.
5. Tests run in isolation (no real Supabase or Gemini calls — mocked or using test doubles).
6. CI completes in < 3 minutes for fast feedback.

**Frontend**
- No UI; CI is a developer-facing workflow.

**Backend**
- `.github/workflows/ci.yml` with steps: checkout → Node 20 setup → `npm ci` → `npm run lint` → `tsc --noEmit` → `npm run test`.
- Test environment: uses `vitest` (already configured) with mocked Supabase and Gemini clients.
- Branch protection rule: require CI to pass before merge to `main`.
- Current test coverage: 9 test files, ~100 tests. Expand before enabling as a merge gate.

---

### OPS-02 — Staging deploy from staging branches
**Priority:** High | **Status:** ⛔ Superseded (owner 2026-11-12, ARC-20): staging retired; production only.

**User Story**  
As the owner, I want pushing a staging/X.Y.Z branch to deploy v2 to ricotdin-staging.mmlabs.online so that I can try a release on the real server before production.

**Context**
v2 has CI and a tag-driven production release (`release.yml` → deployment PR, ARC-15), but nothing has ever run on the server, and the cutover runbook needs a staging rehearsal. Rewritten for v2 on 2026-11-09 (the v1 spec assumed two Supabase projects and Vercel). Owner decisions 2026-11-09: cutting `staging/X.Y.Z` from dev deploys staging, every push redeploys; same home server and self-hosted runner `mmlabs-server` (since PR #86: `macbook-runner`, mmlabs-server is retired); DB = the Neon dev branch already in the owner's local `.env`, used only through the three provisioned logins; hosts web `ricotdin-staging.mmlabs.online`, API `ricotdin-staging-api.mmlabs.online` (one-level sibling subdomains: host-only SameSite=Lax refresh cookie, Cloudflare's free certificate covers `*.mmlabs.online` only); no access gate but no SMTP (nobody can register); Drive folder shared with local (`drive_config` lives in the shared DB); v1 (`apps/ricotdin`) is in use and not touched. Rejected: a separate Neon branch (owner wants the current DB), deploying straight from the runner without a PR (no audit trail), Cloudflare Access (no SMTP is enough).

**Use Cases**
1. The owner bumps the versions to 2.0.0 on dev, cuts `staging/2.0.0` and pushes it; about 15 min later staging runs the new build.
2. The owner pushes a fix to `staging/2.0.0`; staging is redeployed with the new commit.
3. A broken build fails its health check; the previous staging release is restored and the run and PR show red.

**Frontend**
- None (the web image is reused; staging sets `RICOTDIN_API_URL` to the staging API host).

**Backend**
- `.github/workflows/release-staging.yml` (push to `staging/**`): guard (branch name ↔ both version files), reuse `ci-api.yml` + `ci-web.yml` (`workflow_call`), build + push `mingming21400/ricotdin-api` and `ricotdin-web` as `:staging-X.Y.Z-<sha7>` (never `latest`), then open or update a PR on mmlabs-online/deployment writing only `apps/ricotdin-v2-staging/release.env` (`RICOTDIN_API_IMAGE` / `RICOTDIN_WEB_IMAGE` pinned `:tag@sha256:…`, `RICOTDIN_VERSION` = the tag) and enable auto-merge. Secrets: `DEPLOY_REPO_TOKEN`, `DOCKERHUB_*` (existing). Actions pinned by SHA.
- Pure logic `app/api/app/ops/staging_release.py` used by the guard: `parse_staging_ref(ref)`, `staging_tag(version, sha)`, `check_versions(branch, api, web)`.
- Deployment-repo drafts in `docs/ops/deployment-repo/`: `apps/ricotdin-v2-staging/compose.yml` (project `ricotdin-v2-staging`, network aliases `ricotdin-staging-api` / `ricotdin-staging-web`, env files `/Users/mingming/.config/ricotdin-staging/{api,worker,web}.env` (PR #86), same hardening as `ricotdin-v2`), `.github/workflows/deploy-ricotdin-v2-staging.yml` (like `deploy-ricotdin-v2.yml`: pull, `up --wait`, restore on unhealthy, revert push, PR comment; on push to main touching `apps/ricotdin-v2-staging/**`), `pr-scope.yml` accepting `apps/ricotdin-v2-staging/`, README steps.
- Version bump: `app/api/pyproject.toml` + `app/web/package.json` → 2.0.0 on dev.
- No migration step: the owner runs `alembic upgrade head` on the dev branch before cutting or pushing a staging branch that brings a migration.

**Acceptance Criteria**
- Given `staging/2.0.0` is pushed and both version files say 2.0.0, when release-staging runs, then both CI suites pass, two images tagged `staging-2.0.0-<sha7>` are on Docker Hub, and a deployment PR changing only `apps/ricotdin-v2-staging/release.env` (digest pins) has auto-merge enabled.
- Given `staging/2.0` or `staging/2.0.1` while the files say 2.0.0, when it is pushed, then the guard fails before any build or push.
- Given that PR is merged, when deploy-ricotdin-v2-staging runs on macbook-runner, then api, worker and web are healthy, `https://ricotdin-staging-api.mmlabs.online/version.json` returns `staging-2.0.0-<sha7>` and an existing account signs in at `https://ricotdin-staging.mmlabs.online`.
- Given a release whose API is unhealthy, when the deploy runs, then the previous `release.env` is restored and redeployed, the revert is pushed and the run is red.
- Given a deployment PR from this workflow touching `apps/ricotdin/` or `apps/ricotdin-v2/`, then pr-scope rejects it: production and v1 are never changed by staging.

**Test Plan**
- Pure: `app/api/app/ops/staging_release.py`; tests `app/api/tests/test_staging_release.py` — valid / invalid refs (`staging/2.0.0`, `staging/2.0`, `staging/v2.0.0`, `staging/2.0.0-rc1`, `feature/x`), tag format, version mismatch.
- Workflows: actionlint clean on the two new workflows; `docker compose -f …/compose.yml config` with a sample `release.env`.
- End to end: the done check.

**Structural flags**
- New workflow here and in another repo (drafts copied by the owner); new server env files + cloudflared hostnames; Docker Hub repos `ricotdin-api` / `ricotdin-web` must exist; auto-merge enabled on the deployment repo. No migration, no new app env var.

**Done check**
- Cut `staging/2.0.0`: both hostnames answer with the right version; an empty commit pushed to the branch redeploys a new `<sha7>`.

**Out of scope**
- Production go-live (ARC-15 cutover), automatic migrations, an access gate, a staging banner, a separate staging DB or Drive folder, v1 deploys (OPS-05).

**Key files (expected)**
- `.github/workflows/release-staging.yml`, `app/api/app/ops/staging_release.py`, `app/api/tests/test_staging_release.py`, `docs/ops/deployment-repo/apps/ricotdin-v2-staging/compose.yml`, `docs/ops/deployment-repo/.github/workflows/deploy-ricotdin-v2-staging.yml`, `docs/ops/deployment-repo/README.md`, `docs/ops/staging.md`, `app/api/pyproject.toml`, `app/web/package.json`

---

### OPS-03 — Periodic DB backup (Supabase Free)
**Priority:** High | **Status:** ⛔ Superseded (owner 2026-11-19): Supabase retired; nightly dumps of the shared Postgres back up v2.

> **Superseded (ARC-20 / ARC-16):** the Supabase/Neon `backup.yml` workflow below is removed and its
> pending setup steps are dropped; Supabase is never backed up again (no final dump, owner decision
> 2026-11-19). Backups are now the shared Postgres's nightly dumps: `docs/ops/backup-restore.md`.

**User Story**  
As the owner, I want an encrypted off-site copy of the database every day so that I can recover meetings and accounts after a mistake or an incident.

**Context**
The project is on Supabase Free, which has no automated backups, and meetings now hold sensitive
data. Chosen: a GitHub Actions cron (off-site, independent of the home server and OPS-05, no app
code) using `supabase db dump`, encrypted with an **age public key** so GitHub never holds a key
that can decrypt. Retention 30 days (owner choice). Rejected: home-server cron (depends on OPS-05,
backup sits next to what it protects); in-app scheduler (needs pg_dump in the image, stops when the
app is down); an automated weekly restore check (Supabase auth schema/roles make restoring into
vanilla Postgres brittle; a manual restore into a scratch Supabase project is the stronger proof).

**Use Cases**
1. Every day the workflow produces one encrypted backup in R2; the owner can also run it on demand.
2. Backups older than 30 days are removed automatically.
3. After an incident the owner downloads a backup, decrypts it with the offline private key and restores it following the runbook.

**Frontend**
- None.

**Backend**
- `.github/workflows/backup.yml`: `schedule` (daily, 02:00 UTC) + `workflow_dispatch`; `ubuntu-latest`; `permissions: contents: read`.
  1. Supabase CLI (pinned version): `supabase db dump --db-url "$SUPABASE_DB_URL"` three times → `roles.sql` (`--role-only`), `schema.sql`, `data.sql` (`--data-only --use-copy`). `SUPABASE_DB_URL` = the **Session pooler** connection string (IPv4; GitHub runners have no IPv6).
  2. `tar czf` the three files → `age -r "$AGE_RECIPIENT"` → `ricotdin-db-<UTC yyyyMMddTHHmmZ>.tar.gz.age`. Plaintext stays on the runner's temp disk only; never uploaded or saved as an artifact.
  3. Upload to the backup bucket under `db/` with `scripts/backup/r2.ts upload` (AWS SDK S3 client, already a dependency).
  4. Only if the upload succeeded: `scripts/backup/r2.ts prune` deletes expired backups.
- `lib/backup/retention.ts` (pure): object naming + expiry selection.
- GitHub secrets (CI only, never app env vars): `SUPABASE_DB_URL`, `AGE_RECIPIENT`, `R2_BACKUP_ACCOUNT_ID`, `R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY`, `R2_BACKUP_BUCKET`. The R2 token is scoped to the backup bucket only (Object Read & Write), separate from the app's audio bucket (which stays DB-configured, §9a/7).
- `docs/ops/backup-restore.md`: one-time setup (age key pair, R2 bucket + scoped token, secrets), restore runbook (download → `age -d -i key.txt` → `tar xzf` → `psql` roles, schema, data into a scratch Supabase project, per Supabase's restore guide), and a restore-test log.

**Acceptance Criteria**
- Given the schedule fires or the workflow is dispatched, when it succeeds, then exactly one new object `db/ricotdin-db-<UTC timestamp>.tar.gz.age` exists in the backup bucket and decrypts (with the private key) to `roles.sql`, `schema.sql`, `data.sql`.
- The workflow only has the age **public** key: no secret or artifact in GitHub can decrypt a backup, and no plaintext dump is uploaded anywhere.
- Given backups older than 30 days exist, when the workflow runs after a successful upload, then those are deleted; the newest backup is never deleted, and objects whose names don't match the backup pattern are never touched.
- Given the dump or the upload fails, then the workflow fails (GitHub notifies the owner) and prune does not run.
- Given the latest backup, when the owner follows the runbook into a scratch Supabase project, then the row counts of `meetings`, `transcript_segments` and `profiles` match production at dump time (recorded in the runbook's restore log).

**Test Plan**
- Pure logic: `lib/backup/retention.ts` → `backupObjectKey(date)`, `parseBackupTimestamp(key)` (null for non-matching keys), `selectExpiredBackups(keys, nowMs, retentionDays)` (never the newest; ignores non-matching keys; `retentionDays < 1` → nothing).
- Tests: `tests/backup-retention.test.ts` — key format round-trip, UTC, malformed keys ignored, exact 30-day boundary, newest kept even when all are old, empty list.

**Structural flags**
- New GitHub Actions workflow + 6 new **GitHub secrets** (CI-only, not app env vars). New R2 bucket + scoped API token (dashboard). No migration, no app code path changes.

**Done check**
- `workflow_dispatch` run is green and the object appears in R2; `actionlint .github/workflows/backup.yml` clean; `npm test` passes; one restore into a scratch Supabase project done and logged in `docs/ops/backup-restore.md`.

**Out of scope**
- Audio/storage backup (R2 is the durable store; PRV-02 purges audio by policy).
- Automated restore verification; admin backup-status page.
- Point-in-time recovery (requires a paid tier).

**Key files (expected)**
- `.github/workflows/backup.yml`
- `lib/backup/retention.ts`, `tests/backup-retention.test.ts`
- `scripts/backup/r2.ts`
- `docs/ops/backup-restore.md`, `docs/privacy/retention-policy.md` (backups keep deleted data up to 30 days)
- `package.json` (test script)

---

### OPS-04 — Tag-driven release to deployment repo
**Priority:** High | **Status:** ✅ Done — done-check passed 2026-10-21 (end-to-end tag push first exercised at v1.1.0)

**User Story**  
As the owner, I want pushing a vX.Y.Z tag to build the image and open a deploy PR on mmlabs-online/deployment so that releasing to the home server is one reviewed merge.

**Context**
Today `release.yml` pushes `ricotdin:X.Y.Z` + `latest` to Docker Hub and deploy is fully manual (CLAUDE.md §9k).
The home server is driven by `mmlabs-online/deployment`: merging a PR that changes
`apps/<app>/release.env` runs `deploy-<app>.yml`. The template is `docs/app-release.yml` in that repo.
Chosen: **extend** the existing `release.yml` (keep the `verify` job, release/X.Y and package.json
tag guards, NEXT_PUBLIC build args, `latest`-only-if-highest) and add digest capture + the
deployment PR. Rejected: replacing with the bare template (loses verify/guards); auto GitHub Release
(stays manual, §9k step 6); setting up apps/ricotdin in the deployment repo (OPS-05).

**Use Cases**
1. Owner pushes `v1.1.0` on `release/1.1` → verify passes → image `mingming21400/ricotdin:v1.1.0` pushed → PR "ricotdin v1.1.0" opened on mmlabs-online/deployment.
2. Owner reviews and merges that PR → home server deploys the exact digest (once OPS-05 is in place).
3. Operator/healthcheck hits `/api/health`; anyone can read `/version.json` to see which release is running.

**Frontend**
- None (no UI version display in this slice).

**Backend**
- `.github/workflows/release.yml`, all jobs on `ubuntu-latest` (never self-hosted); top-level `permissions: contents: read`.
  - Env: `APP=ricotdin`, `IMAGE=mingming21400/ricotdin`, `VAR=RICOTDIN_IMAGE`, `VERSION_VAR=RICOTDIN_VERSION`.
  - Trigger pattern `'v[0-9]+.[0-9]+.[0-9]+*'`; the existing guards still reject tags not on release/X.Y or not equal to package.json.
  - build job: checkout → `docker/setup-buildx-action` → `docker/login-action` (`DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN`) → `docker/build-push-action` with `id: build`, context `.`, push, tags `$IMAGE:${{ github.ref_name }}` (+ `$IMAGE:latest` only when highest tag), build-args `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `BUILD_COMMIT=${{ github.sha }}`. The tag is NOT baked in (image is promoted by digest).
  - deployment PR step (`GH_TOKEN: secrets.DEPLOY_REPO_TOKEN`, `DIGEST: steps.build.outputs.digest`): clone mmlabs-online/deployment, branch `release/ricotdin-<tag>`, write `apps/ricotdin/release.env` with exactly:
    `# Written by the ricotdin release workflow for <tag> (commit $GITHUB_SHA). Do not edit by hand.`
    `RICOTDIN_IMAGE=mingming21400/ricotdin:<tag>@<digest>`
    `RICOTDIN_VERSION=<tag>`
    then `git add apps/ricotdin/release.env` (not `commit -am`: the file is new on the first release), commit, push, `gh pr create --title "ricotdin <tag>"`. Nothing else in that repo changes (its `pr-scope.yml` enforces apps/ricotdin/ only).
  - If a GitHub Release step is ever added: that job needs `permissions: contents: write` and `GH_TOKEN: ${{ github.token }}`, never `DEPLOY_REPO_TOKEN`.
- `app/api/health/route.ts`: public `GET` → 200 `{ "status": "ok" }`, no DB/provider calls, `dynamic = 'force-dynamic'`.
- `app/version.json/route.ts`: public `GET` → `{ "version": resolveAppVersion(...) }` from `process.env.RICOTDIN_VERSION` / `BUILD_COMMIT`, `Cache-Control: no-store`.
- `Dockerfile`: `ARG BUILD_COMMIT` → `ENV BUILD_COMMIT` in the runtime stage; `PORT=3000`, non-root `node` user (changed from `:80` after BUG-001); busybox `wget` present (node:20-alpine); `HEALTHCHECK` with `wget -q --spider http://127.0.0.1:3000/api/health`.
- Docs: CLAUDE.md §9k (image `mingming21400/ricotdin`, v-prefixed tags, deploy = merge the deployment PR, secret `DEPLOY_REPO_TOKEN`, runtime `RICOTDIN_VERSION`); CHANGELOG deploy checklist.

**Acceptance Criteria**
- Given a tag `vX.Y.Z` on `release/X.Y` equal to package.json, when it is pushed, then `mingming21400/ricotdin:vX.Y.Z` is pushed (plus `latest` only if it is the highest tag) and a PR titled `ricotdin vX.Y.Z` exists on mmlabs-online/deployment whose only change is `apps/ricotdin/release.env` with exactly the three lines above (real digest, `$GITHUB_SHA`).
- Given a tag not on `release/X.Y` or not matching package.json, when it is pushed, then no image is pushed and no deployment PR is opened.
- Given a container started with no secrets, when `GET /api/health` is called, then it returns 200 `{"status":"ok"}` and the process stays up.
- Given `RICOTDIN_VERSION=v1.2.3`, when `GET /version.json` is called, then it returns `{"version":"v1.2.3"}`; given it is empty/unset, then it returns the baked `BUILD_COMMIT`; given both empty, then `"unknown"`.
- The image contains `wget`, listens on :3000, and has no tag-derived value baked in.
- `actionlint .github/workflows/release.yml` reports no errors.

**Test Plan**
- Pure logic: `lib/release/version.ts` → `resolveAppVersion({ version?, commit? }): string` (trim; version wins; commit fallback; `'unknown'`).
- Tests: `tests/app-version.test.ts` — version set; whitespace-only version → commit; both empty → `'unknown'`; trimming. Add to the `npm test` script.

**Structural flags**
- No migration. New GitHub secret `DEPLOY_REPO_TOKEN` (fine-grained PAT, mmlabs-online/deployment only: Contents + Pull requests read/write).
- New runtime env `RICOTDIN_VERSION` (non-secret, set via release.env) + build arg `BUILD_COMMIT`.
- Release contract change: image namespace fixed to `mingming21400/ricotdin`, image tags gain the `v` prefix → §9k and deploy docs must be updated.
- Runtime secrets come from a server-side env file referenced by apps/ricotdin/compose.yml (OPS-05).

**Done check**
- `actionlint .github/workflows/release.yml` passes; `npm test` passes.
- `docker build --secret id=env,src=.env.local --build-arg BUILD_COMMIT=$(git rev-parse HEAD) -t ricotdin:local . && docker run -d -p 8080:3000 -e RICOTDIN_VERSION=v9.9.9 ricotdin:local` → `curl -i :8080/api/health` is 200, `curl :8080/version.json` is `{"version":"v9.9.9"}`, `docker exec <id> wget --help` succeeds.
- Delivered as one commit + one PR (not merged).

**Out of scope**
- mmlabs-online/deployment side: `apps/ricotdin/compose.yml`, `deploy-ricotdin.yml`, server env file → OPS-05.
- Auto-creating the GitHub Release; showing the version in the UI; `release-dev.yml` changes.

**Key files (expected)**
- `.github/workflows/release.yml`
- `app/api/health/route.ts`
- `app/version.json/route.ts`
- `lib/release/version.ts`
- `tests/app-version.test.ts`
- `Dockerfile`, `package.json`, `CLAUDE.md`, `CHANGELOG.md`

---

### OPS-05 — Deployment-repo setup + release verification
**Priority:** High | **Status:** ⛔ Superseded (owner 2026-11-19): v2 deploys via `apps/ricotdin-v2` (OPS-04, OPS-09).

**User Story**  
As the owner, I want ricotdin set up in mmlabs-online/deployment and a repeatable check that a release really runs there so that merging a release PR is proven to deploy the right version.

**Context**
OPS-04 opens `release/ricotdin-vX.Y.Z` PRs, but the deployment repo has no `apps/ricotdin/` and no
`deploy-ricotdin.yml`, so merging deploys nothing. Unlike `site`/`calechip` (static nginx, no
secrets), ricotdin is a Next.js server that needs runtime secrets (Supabase service role,
`KEY_ENCRYPTION_SECRET`, provider keys) and ffmpeg. Chosen: follow the calechip pattern — keep the
drafts in this repo under `docs/ops/deployment-repo/`, the operator copies them into the deployment
repo; secrets live in a server-side env file that is never committed anywhere. Plus a verification
prompt (below) that checks every link of the chain after each release.

**Use Cases**
1. Operator copies the drafts into mmlabs-online/deployment and creates the server env file once.
2. Owner merges a `ricotdin vX.Y.Z` PR → `deploy-ricotdin` pulls the pinned digest, starts it, waits for `/api/health`, rolls back on failure, comments the outcome on the PR.
3. After any release, owner runs the verification prompt and gets a pass/fail per check.

**Frontend**
- None.

**Backend**
- `docs/ops/deployment-repo/apps/ricotdin/compose.yml` (draft): project `ricotdin`; `image: ${RICOTDIN_IMAGE:?...}`; `environment: RICOTDIN_VERSION: ${RICOTDIN_VERSION:-}`; `env_file:` the server-side secrets file (fixed absolute path on the home server, chmod 600, outside every repo); healthcheck `wget -q --spider http://127.0.0.1:3000/api/health` with a `start_period` long enough for Next start; `restart: unless-stopped`; no published ports; network `web` (external) so cloudflared reaches it by service name; generous `stop_grace_period` for in-flight pipeline jobs.
- `docs/ops/deployment-repo/.github/workflows/deploy-ricotdin.yml` (draft): copy of `deploy-site.yml` with `APP_DIR=apps/ricotdin`, `PROJECT=ricotdin`, `RICOTDIN_IMAGE` and the pattern `^mingming21400/ricotdin:v[0-9]+\.[0-9]+(\.[0-9]+)?(-[0-9A-Za-z.-]+)?@sha256:[0-9a-f]{64}$`; fails early with a clear error if the server env file is missing.
- `docs/ops/deployment-repo/README.md`: copy steps, server env file contents (variable NAMES only, from CLAUDE.md §8), cloudflared hostname, first manual deploy, rollback, and the verification prompt.
- Migrations for a release are still applied before merging its deployment PR (§9k).

**Verification prompt** (paste into Claude Code from this repo after a release; read-only, replace `<TAG>` and `<PUBLIC_URL>`):

```
Verify that ricotdin <TAG> is really deployed. Read-only: do not push, merge, edit or re-run
anything. For every check print PASS / FAIL / CANNOT-CHECK with the evidence (command + output).
1. Release workflow: in this repo, the "Release" run for tag <TAG> succeeded
   (gh run list --workflow release.yml), and its verify + build jobs are green.
2. Image: mingming21400/ricotdin:<TAG> exists on Docker Hub; record its digest
   (docker buildx imagetools inspect).
3. Deployment PR: on mmlabs-online/deployment, PR "ricotdin <TAG>" from release/ricotdin-<TAG>
   exists, pr-scope passed, it is merged, and its only changed file is apps/ricotdin/release.env.
4. Pinned release: on main of mmlabs-online/deployment, apps/ricotdin/release.env has exactly
   three lines: the "Written by the ricotdin release workflow for <TAG>" comment,
   RICOTDIN_IMAGE=mingming21400/ricotdin:<TAG>@<digest from step 2>, RICOTDIN_VERSION=<TAG>.
5. Deploy run: the deploy-ricotdin run for that merge commit succeeded, its summary says
   "deployed", and no "Restore ricotdin" commit followed it on main.
6. Live app: GET <PUBLIC_URL>/api/health returns 200 {"status":"ok"} and
   GET <PUBLIC_URL>/version.json returns {"version":"<TAG>"}.
7. Drift: the drafts in docs/ops/deployment-repo/ match the copies in the deployment repo
   (compose.yml, deploy-ricotdin.yml); list any differences.
End with one line: DEPLOYED <TAG> or NOT DEPLOYED, plus the first failing check.
```

**Acceptance Criteria**
- Given the drafts copied into mmlabs-online/deployment and the server env file present, when a `ricotdin vX.Y.Z` PR is merged, then `deploy-ricotdin` starts the pinned digest, the container is healthy within the wait timeout, and the PR gets a "deployed" comment.
- Given a release whose container fails `/api/health`, when its PR is merged, then the previous release is restored, the revert is pushed to main, and the PR comment says "restored".
- Given the server env file is missing, when the deploy runs, then it fails before starting anything with an error naming the file (never printing its contents).
- Given a release deployed this way, when the verification prompt is run, then all 7 checks report PASS and it ends with `DEPLOYED <TAG>`.
- No secret value appears in any committed file in either repo.

**Test Plan**
- No new app logic (docs + YAML drafts only), so no new unit tests.
- `actionlint docs/ops/deployment-repo/.github/workflows/deploy-ricotdin.yml`; `docker compose -f docs/ops/deployment-repo/apps/ricotdin/compose.yml --env-file <sample release.env> config --quiet` with a dummy env file.
- End-to-end: one real release, then the verification prompt.

**Structural flags**
- Touches another repository (copied by the operator, not by CI). Requires a server-side secrets file and a cloudflared hostname for ricotdin. Self-hosted runner `mmlabs-server` must have Docker access to the `web` network.

**Done check**
- First real release via OPS-04 → verification prompt prints `DEPLOYED <TAG>`.

**Out of scope**
- Staging environment (OPS-02); secret managers/vaults; DB backups (OPS-03); remuxing audio.

**Key files (expected)**
- `docs/ops/deployment-repo/README.md`
- `docs/ops/deployment-repo/apps/ricotdin/compose.yml`
- `docs/ops/deployment-repo/.github/workflows/deploy-ricotdin.yml`

---

### OPS-06 — CI on dev branch
**Priority:** Medium | **Status:** ✅ Done

**User Story**  
As the owner, I want lint, typecheck and tests to run on every PR into dev and every push to dev so that agent-made changes show a red/green signal before and after they land.

**Context**
`ci.yml` (OPS-01) only triggers on push/PR to `main` and `release/**`, so the agent PRs into `dev` (#20, #21) merged with no checks; `release-dev.yml` only builds the image after a push. Chosen: B, add `dev` to both `push` and `pull_request`, informational only (owner decision: no required check, no build step). Rejected: A (PR only), cheaper, but there's no signal for direct pushes/merges to dev.

**Use Cases**
1. Agent opens a PR into `dev` → "lint · typecheck · test" runs and shows on the PR.
2. PR is merged (or a commit is pushed to `dev`) → CI runs on `dev`.

**Frontend**
- None.

**Backend**
- `.github/workflows/ci.yml`: add `dev` to `on.push.branches` and `on.pull_request.branches`. Job steps unchanged.

**Acceptance Criteria**
- Given a PR into `dev`, when it is opened or updated, then the "lint · typecheck · test" check runs and its result is shown on the PR.
- Given a push to `dev` (including a PR merge), then the CI workflow runs on `dev` (`gh run list --workflow ci.yml --branch dev --event push`).
- Triggers for `main` and `release/**` are unchanged.
- A red CI on a PR into `dev` does not block merging (no ruleset/branch-protection change).
- No build step is added; the job's steps are identical to before.

**Test Plan**
- No pure logic: the change is workflow config only, so there is no unit test (`CLAUDE.md` §10 tests cover pure functions). Verified by observable runs (Done check).

**Structural flags**
- None (one workflow file; no migration, env var, provider or RLS change).

**Done check**
- The OPS-06 PR into `dev` shows the "lint · typecheck · test" check (the PR triggers its own workflow), and after merge `gh run list --workflow ci.yml --branch dev --event push --limit 1` shows a run.

**Out of scope**
- Making CI a required check on `dev` (owner decision: informational only).
- `npm run build` in CI (owner decision; `release-dev.yml` still builds after push).
- Having `/ship-feature` and `/fix-bug` wait for `gh pr checks` before asking to merge (workflow follow-up, not a product feature).

**Key files (expected)**
- `.github/workflows/ci.yml`
- `CLAUDE.md` §9k ("ci.yml runs on push/PR to main and release/**"), `CHANGELOG.md` `[Unreleased]` (OPS-06 entry; the 1.1.0 Known issues line about CI only on main stays as history)

---

### OPS-07 — Release runbook + deploy verify
**Priority:** High | **Status:** ✅ Done

**User Story**  
As the owner, I want one ordered runbook and a verify command for every release so that I can deploy by hand or through the pipeline without missing a migration or deploying the wrong version.

**Context**
The steps are spread over the CHANGELOG deploy checklists, `docs/ops/backup-restore.md` and `docs/ops/deployment-repo/README.md`; the owner deploys with a manual `docker run` this week (v1.1.0), then via OPS-05. Chosen: A — runbook + HTTP verify script. Rejected: B (script also runs migration verify queries via `SUPABASE_DB_URL`: new `pg` dependency + DB secret on the laptop); C (runbook only, verify by hand).

**Use Cases**
1. Owner follows the one-time section: deploy v1.1.0 with `docker run` (incl. `-e RICOTDIN_VERSION=v1.1.0`), first backup run + restore test, OPS-05 first-time setup (rotate tunnel token, decide deployment PR #9, copy drafts, merge PR #10).
2. For every later release: apply that release's migrations + verify queries → deploy (merge the deployment PR) → `npm run verify:deploy` → rollback if needed.
3. After any deploy: `npm run verify:deploy -- https://<host> --expect v1.1.0` prints PASS/FAIL per check and exits non-zero on any FAIL.

**Frontend**
- None.

**Backend**
- `docs/ops/release-runbook.md`: "One-time (2026-10)" + "Every release" sections; links to, not copies of, the CHANGELOG checklist, backup-restore and OPS-05 README; manual `docker run` command template with `RICOTDIN_VERSION`.
- `scripts/verify-deploy.ts` + `"verify:deploy"` in package.json: fetches `<url>/version.json` and `<url>/api/health` (timeout), passes results to a pure evaluator, prints a report.

**Acceptance Criteria**
- Given a deploy whose `/version.json` is `{"version":"v1.1.0"}` and `/api/health` is 200 `{"status":"ok"}`, when `verify:deploy -- <url> --expect v1.1.0` runs, then both checks PASS and the exit code is 0.
- Given `/version.json` returns another version, a commit SHA or `unknown`, then the version check FAILs, the exit code is non-zero, and a SHA/`unknown` adds the hint "set RICOTDIN_VERSION".
- Given `/api/health` is not 200, unreachable, or not `{"status":"ok"}`, then the health check FAILs with the reason.
- Given no `--expect`, then the version is printed and the version check is skipped (health still checked).
- The runbook lists, in order, the one-time steps (v1.1.0 `docker run`, migrations 032–036 + verify queries, first backup + restore, tunnel token rotation, PR #9 decision, OPS-05 copy + merge #10) and the per-release steps, each ending with how to verify it.

**Test Plan**
- Pure logic: `lib/release/verifyDeploy.ts` → `evaluateDeploy({ expected?, version: {status, body} | {error}, health: {status, body} | {error} })` → `{ checks: [{name, ok, detail}], ok }`; `parseVerifyArgs(argv)` → `{ url, expected? }` (typed error on missing/invalid URL).
- Tests: `tests/verify-deploy.test.ts` — match, mismatch, SHA/`unknown` hint, health non-200/bad body/network error, no `--expect`, arg parsing.

**Structural flags**
- None (one script, one doc, one pure module; no migration, env var, dependency or secret).

**Done check**
- `npm run verify:deploy -- <prod url> --expect v1.1.0` after the owner's v1.1.0 deploy prints two PASS lines.

**Out of scope**
- Running migration verify queries automatically (option B).
- Changing the deploy pipeline or the deployment repo.

**Key files (expected)**
- `docs/ops/release-runbook.md`, `scripts/verify-deploy.ts`, `lib/release/verifyDeploy.ts`, `tests/verify-deploy.test.ts`, `package.json`

---

### OPS-08 — Local dev sign-in (dev token proxy)
**Priority:** Medium | **Status:** 🟡 Implemented (feat/OPS-08-local-dev-sign-in); owner end-to-end check pending

**User Story**  
As a developer, I want `npm run dev` to open ricotdin already signed in as an mmlabs account I choose so that I can use every screen against my local API although mmlabs Identity only accepts the production origin.

**Context**
mmlabs Identity registers only `https://ricotdin.mmlabs.online`, so the SPA's sign-in (AUT-05) cannot run from `localhost:5173`; today local dev cannot get past the sign-in screen. tudocuatui solved this with a dev token file + a dev-only proxy that adds the bearer server-side (T-025); this ports that. The ricotdin API is served at `/` and `config.json` takes a plain origin, so the proxy uses the prefix `/__dev_api` and serves its own dev `config.json`. Rejected: a standalone proxy on :8001 (third process, CORS); making the real sign-in form work through a proxied Identity (spoofed Origin + cookies, Turnstile; parked).

**Use Cases**
1. Developer runs `scripts/dev-token.sh` (email + password asked; `RICOTDIN_DEV_EMAIL` optional), then `RICOTDIN_DEV_TOKEN=1 npm run dev`; the app opens signed in as that account.
2. To test another account (e.g. a non-admin), re-run the script with another email; reload, no Vite restart.
3. Token expires (15 min): the next API 401 re-checks the session → retry screen, and Vite logs "run scripts/dev-token.sh"; re-run, press retry.

**Frontend** (as built)
- `app/web/scripts/dev-token.sh` (port of tudocuatui's: app `ricotdin`, Origin `https://ricotdin.mmlabs.online`, default file `~/.config/ricotdin/dev-token`, override `RICOTDIN_DEV_TOKEN_FILE`; password via `read -s`, never in argv/file/stdout; fresh 0600 `mktemp` file renamed atomically; xtrace off).
- `app/web/dev/devTokenProxy.ts`: Vite plugin, `apply` only for `serve` (never build/preview) and only when `RICOTDIN_DEV_TOKEN=1`. Proxies `^/__dev_api(/|?|$)` (prefix stripped) and `^/media(?|$)` (the playback link `mediaSrc` resolves to the origin root) → `RICOTDIN_DEV_API` (default `http://127.0.0.1:8000`, loopback only). Drops the client's `Authorization`; adds the bearer (token file read per request) only for `Sec-Fetch-Site: same-origin`, a `localhost` / `127.0.0.1` Host and a matching `Origin` when sent. Serves `/config.json` = `{apiUrl: <origin>, authUrl: <origin>, devProxy: '/__dev_api'}` for a local Host only. Refuses `--host`, `::1`, `allowedHosts: true`.
- `src/lib/devConfig.ts` `withDevProxy()`: applied by `loadRuntimeConfig` only under `import.meta.env.DEV`; moves `apiUrl` under `/__dev_api` and sets `devProxy: true`. `parseRuntimeConfig` is unchanged (a path is still rejected; an unknown `devProxy` key is ignored).
- Session: no separate class (`AuthSession` has private fields, so a second class would need every consumer retyped). `SessionDeps.devProxy` (set by `main.tsx` only under `import.meta.env.DEV && config.devProxy`) makes `refreshOnce` call `fetchDevState()` (`src/auth/devSession.ts`: `GET /auth/me`, no token → `devAuthState()`: a user → `signedIn`, anything else → `unavailable`), with the sign-out epoch check; `getToken()` → `null`. `authFetch` re-checks the session on a 401 in this mode.

**Backend**
- None. No dev bypass in the API: it verifies the real mmlabs token as in production.

**Acceptance Criteria**
- Given a valid token file and `RICOTDIN_DEV_TOKEN=1 npm run dev`, when `http://localhost:5173` opens, then the app is signed in as that account and `/meetings` loads from the local API.
- Given the token file is missing, malformed or expired, when a request goes through the proxy, then no `Authorization` is sent, the API answers 401, and Vite logs `[dev-token] token <status> - run scripts/dev-token.sh` once per status change.
- Given a request that is not same-origin (missing / cross-site / same-site / none `Sec-Fetch-Site`), a non-local Host or a foreign Origin, or one carrying a client `Authorization`, when it hits the proxy, then the client header is dropped and no bearer is added.
- Given `npm run build`, then `dist/` contains no `__dev_api`, `dev-token`, `devProxy`, `RICOTDIN_DEV` or token-file path (grep check); production `config.json` with a path is still rejected and a `devProxy` key is ignored.
- Given `RICOTDIN_DEV_API` is not loopback or the server uses `--host` / `::1`, then `npm run dev` refuses to start.

**Test Plan** (as built)
- Pure logic: `app/web/dev/devTokenProxy.ts` → `proxyTarget()`, `assertLocalServer()`, `tokenFilePath()`, `readDevToken()`, `rewriteAuth()`, `warningFor()`, `stripPrefix()`, `devConfig()`; `src/lib/devConfig.ts` → `withDevProxy()`; `src/auth/devSession.ts` → `devAuthState()`, `fetchDevState()`.
- Tests: `app/web/dev/devTokenProxy.test.ts`, `app/web/src/lib/devConfig.test.ts`, `app/web/src/auth/devSession.test.ts`, `app/web/src/auth/session.test.ts` (dev proxy block), `app/web/src/api/client.test.ts` (dev 401), `app/web/scripts/dev-token.test.ts` (static invariants: no password in argv, token only to a 0600 temp file, xtrace off).

**Structural flags**
- Auth in the browser (dev-only code path; build must not contain it), new dev-only env vars `RICOTDIN_DEV_TOKEN`, `RICOTDIN_DEV_API`, `RICOTDIN_DEV_EMAIL`, `RICOTDIN_DEV_TOKEN_FILE`; ~9 files. Stop for plan approval.

**Done check**
- On WSL/macOS: API running locally, `scripts/dev-token.sh`, `RICOTDIN_DEV_TOKEN=1 npm run dev` → app signed in, meetings list loads; `npm run typecheck && npm test && npm run build` green and the `dist/` grep is empty.

**Out of scope**
- Native Windows (PowerShell/Node) token script.
- Real sign-in / sign-out / account switch UI from localhost (proxied Identity).
- Any API-side dev bypass.

**Key files**
- `app/web/scripts/dev-token.sh`, `app/web/scripts/dev-token.test.ts`
- `app/web/dev/devTokenProxy.ts`, `app/web/dev/devTokenProxy.test.ts`
- `app/web/vite.config.ts`, `app/web/tsconfig.json`, `app/web/package.json` (`@types/node`), `app/web/src/main.tsx`
- `app/web/src/lib/config.ts`, `app/web/src/lib/devConfig.ts` (+ test)
- `app/web/src/auth/session.ts`, `app/web/src/auth/devSession.ts` (+ tests), `app/web/src/api/client.ts`
- `.gitattributes` (`*.sh` LF), `.gitignore` (`dev-token`), `app/web/README.md`, `docs/architecture/web.md` §0.10

---

### OPS-09 — Release by branch name, auto-deploy
**Priority:** High | **Status:** ✅ Implemented (ci/OPS-09-auto-release)

**User Story**  
As the owner, I want pushing a new branch `release/X.Y.Z` to tag, build and deploy that version so that a release needs no version bump, hand tag or manual deployment merge.

**Context**
The owner cut `release/2.1.1` and `release/2.1.2` expecting a release; `release.yml` only ran for
`release/X.Y` with bumped version files, so nothing happened. Owner decisions 2026-11-17: the version
is the branch name; the deployment PR is merged at once (no wait for its checks); release notes fall
back to GitHub's generated notes.

**Acceptance Criteria**
- Given a new branch `release/2.2.0` is pushed, then tag `v2.2.0` is created, both CI suites run, the images are pushed, the deployment PR is opened and merged (deploy starts there) and a GitHub Release exists.
- Given a later push to an existing `release/X.Y.Z` (tag exists), then nothing is released.
- Given `release/1.2.0` or `release/2.2`, then nothing is tagged (v1 rejected; old `X.Y` lines no longer trigger).
- Given `release/2.2.0-rc1`, then only images are pushed.
- Given a hotfix `release/2.1.3` after `v2.2.0`, then its deployment PR stays open (no automatic rollback).

**Structural flags**
- Production deploy config (High tier): the branch push deploys; no human gate on the deployment PR.

**Done check**
- First real release `release/2.2.0`: the run tags, merges `ricotdin v2.2.0` on the deployment repo and `deploy-ricotdin-v2` succeeds.

**Key files**
- `.github/workflows/release.yml`, `.github/workflows/github-release.yml`, `CLAUDE.md` §9k/§9l, `docs/architecture/release-cutover.md`, `.claude/skills/fix-bug/SKILL.md`

---

## Implementation Order

1. **OPS-01** (CI) — lowest effort, highest confidence gain. Set up GitHub Actions in one session.
2. **OPS-03** (backup) — if on Supabase paid tier, this is a single dashboard toggle. If free tier, write the backup script.
3. **OPS-02** (staging) — v2: `staging/X.Y.Z` branches deploy to ricotdin-staging.mmlabs.online through the deployment repo.

## Dependencies

- **OPS-01 depends on:** existing test suite (`npm run test` already configured)
- **OPS-02 depends on:** OPS-04 (deployment-PR flow), ARC-15 (v2 release workflow + deployment drafts)
- **OPS-03 depends on:** nothing; can be set up anytime
- **OPS-04 depends on:** OPS-01 (the release verify job reuses the CI checks)
- **OPS-05 depends on:** OPS-04 (release PRs must exist before the deployment repo can consume them)
- **OPS-06 depends on:** OPS-01 (extends its ci.yml triggers to `dev`)
- **OPS-07 depends on:** OPS-04 (`/version.json` + `/api/health` endpoints)
- **OPS-08 depends on:** AUT-05 (mmlabs sign-in, `/auth/me`), ARC-11 (SPA runtime config + auth session)

## Current CI Coverage (for context)

| Test File | Coverage Area |
|---|---|
| `admin-guards.test.ts` | Admin guard functions (21 tests) |
| `admin-pipeline.test.ts` | Pipeline admin endpoints (11 tests) |
| `auth-validate.test.ts` | Auth validation (24 tests) |
| `chunk.test.ts` | Transcript chunking |
| `ics.test.ts` | ICS calendar builder (30 tests) |
| `pipeline-parse.test.ts` | Gemini JSON parsing |
| `processMeeting-guard.test.ts` | Processing guards |
| `rag.test.ts` | RAG pipeline (12 tests) |
| `transcode.test.ts` | Audio transcoding |
