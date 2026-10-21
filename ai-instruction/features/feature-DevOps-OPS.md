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

### OPS-02 — Staging environment
**Status:** ❌ Not started  
**Mandatory:** Yes

**User Story**  
As a developer, I want a staging environment separate from real data for safe testing.

**Use Cases**
1. Staging is a separate deployment (separate Supabase project, separate Gemini key).
2. Every merge to `main` auto-deploys to staging.
3. Developer tests features in staging before promoting to production.
4. Staging has its own `.env` with non-production credentials.
5. Staging may use `gemini-2.5-flash-lite` to reduce costs during testing.
6. Production deployment is manual (button click) or triggered by a release tag.

**Frontend**
- Staging URL: `staging.{domain}` or a platform preview URL (Vercel/Railway preview deployments).
- A visible banner in staging: "Staging environment — not for real data."

**Backend**
- Two Supabase projects: `ricotdin-staging` and `ricotdin-prod`.
- Two sets of environment variables in the deployment platform.
- Staging Supabase can be seeded with test data; prod never uses test data.
- DB schema migrations are applied to staging first; then promoted to prod.
- Recommended platforms: Vercel (Next.js-native) or Railway.

---

### OPS-03 — Periodic DB backup
**Status:** ❌ Not started  
**Mandatory:** Yes

**User Story**  
As an operator, I want periodic DB backups to recover from incidents.

**Use Cases**
1. Database is backed up automatically every day.
2. Backups are retained for at least 7 days.
3. In the event of data loss, an operator can restore the DB to a point-in-time within the retention window.
4. Backup process is verified periodically (a backup that can't be restored is not a backup).

**Frontend**
- No user-facing UI.
- Optional: backup status visible in the admin dashboard.

**Backend**
- **Supabase paid tier** includes automatic daily backups with 7-day retention. This is the recommended path.
- **Free tier:** no automated backups — workaround is a scheduled `pg_dump` script (e.g., a GitHub Actions cron or a small cron job on the host).
- Backup script: `pg_dump $DATABASE_URL | gzip > backup-$(date +%Y%m%d).sql.gz` → upload to S3/R2/GCS.
- Restore test: monthly restore to a scratch Supabase project to verify backup integrity.
- Audio files in Supabase Storage: Storage is NOT backed up by Supabase free tier — consider R2/S3 with versioning for production.

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
**Priority:** High | **Status:** ❌ Not started

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

## Implementation Order

1. **OPS-01** (CI) — lowest effort, highest confidence gain. Set up GitHub Actions in one session.
2. **OPS-03** (backup) — if on Supabase paid tier, this is a single dashboard toggle. If free tier, write the backup script.
3. **OPS-02** (staging) — requires provisioning a second Supabase project + deployment platform configuration.

## Dependencies

- **OPS-01 depends on:** existing test suite (`npm run test` already configured)
- **OPS-02 depends on:** OPS-01 (CI must pass before staging auto-deploy)
- **OPS-03 depends on:** nothing; can be set up anytime
- **OPS-04 depends on:** OPS-01 (the release verify job reuses the CI checks)
- **OPS-05 depends on:** OPS-04 (release PRs must exist before the deployment repo can consume them)

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
