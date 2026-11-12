# CLAUDE.md

Project memory for Claude Code. Read this fully at the start of every session.
Keep it updated as the project evolves — this file is the source of truth.

## 0. Layout (v2) — read first

v2 is the only code on `dev`/`main` since **ARC-16** (specs in
`ai-instruction/features/feature-Architecture-ARC.md`, progress in `ai-instruction/tracking.md` ARC rows):

```
app/api/         backend — FastAPI, Python 3.12, uv (API + pipeline worker share one image)
app/web/         frontend — Vite + React SPA
ai-instruction/  tracking, features, bugs, roadmap, ai-gen/ (runtime pipeline prompt)
docs/  .claude/  .github/  CLAUDE.md  CHANGELOG.md  README.md
```

- **v1 (Next.js + Supabase) is gone from `dev`/`main`.** It lives in git history and on
  `release/1.1` (tags ≤ v1.1.1, v1 at the repo root there). **v1 is retired** (owner decision
  2026-11-12, ARC-20): no hotfixes, no data carried over; v2 is the only ricotdin.
  Its rules and designs: `docs/architecture/v1-rules.md` (was `legacy/CLAUDE.md`).
- The frozen v1 schema (`schema.sql` + migrations 001–038) is a test fixture in
  `app/api/tests/fixtures/v1/schema/`: the migration integration test, the schema parity test and
  `scripts.gen_baseline` replay it. Never edit it.
- **Commands:**
  - api: `cd app/api && uv sync && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest -q`
  - web: `cd app/web && npm ci && npm run typecheck && npm test && npm run build`
- **TDD (same rule as §10):** pure logic first, tests before implementation.
  api → `app/api/tests/test_<topic>.py` (pytest, no network/DB unless it is an explicit integration test
  named `test_*_integration.py`); web → `app/web/src/**/<name>.test.ts(x)` (vitest).
- **CI is path-filtered:** `ci-api.yml`, `ci-web.yml`; releases `release.yml` (tags).
- **One environment: production** (`https://ricotdin.mmlabs.online`, API `https://ricotdin-api.mmlabs.online`)
  on the Mac, database `ricotdin` on the shared self-hosted Postgres. No staging (retired 2026-11-12,
  ARC-20). Go-live and release steps: `docs/ops/go-live.md`.
- v2 security rules are the v1 rules (§5–§7, §9b, §9f, §9m) re-stated per ARC spec; secrets stay server-only.
- (ARC-19) §0.1–§0.11 live in `docs/architecture/` (table below); the v1 sections (§1–§9, §9a–§9j,
  §9m–§9o, §11) in `docs/architecture/v1-rules.md`.

### 0.x → file (ARC-19)

The v2 design sections live in `docs/architecture/`. Code comments that cite "CLAUDE.md §0.x" resolve
through this table. **Read the file before working in that area**; its rules are binding.

| § | File | Read before working on |
|---|---|---|
| §0.1 | `docs/architecture/db.md` | self-hosted Postgres (ARC-20), schema, Alembic, DB roles, RLS request context, grants |
| §0.2 | `docs/architecture/api-runtime.md` | FastAPI factory, middleware, logins/pools, `Database` session, image |
| §0.3 | `docs/architecture/auth.md` | register/login/refresh, passwords, JWT, email tokens |
| §0.4 | `docs/architecture/platform-services.md` | crypto, key pool, app config, Google Drive / R2 storage |
| §0.5 | `docs/architecture/data-migration.md` | v1 → v2 data + file migration (not used since ARC-20; tooling kept until ARC-16) |
| §0.6 | `docs/architecture/core-domain-api.md` | meetings, folders/shares, content, profile, quota routes |
| §0.7 | `docs/architecture/worker.md` | pipeline worker, transcription, AI analyse, embed, schedulers |
| §0.8 | `docs/architecture/chat-rag.md` | chat sessions, retrieval scope, grounded answers, citations |
| §0.9 | `docs/architecture/admin-api.md` | admin users, operations, configuration endpoints |
| §0.10 | `docs/architecture/web.md` | SPA foundation, routing, auth in the browser, i18n, screens |
| §0.11 | `docs/architecture/release-cutover.md` | v2 release, supply chain, backup, cutover |

| v1 | `docs/architecture/v1-rules.md` | v1 rules (§5–§7, §9b, §9f, §9m bind v2) and the v1 designs the v2 ports cite |

### Never (verbatim excerpts; the full rule is in the cited file)

From §0 (above):

- v2 security rules are the v1 rules (§5–§7, §9b, §9f, §9m) re-stated per ARC spec; secrets stay server-only.

From §0.1 (`docs/architecture/db.md`):

- (ARC-20) Role names are cluster-wide: **one ricotdin database per server** (production). Runbook,
  migrations + logins from the Mac: `docs/ops/self-hosted-postgres.md`.
  **Never name CREATEDB / CREATEROLE / BYPASSRLS in an ALTER ROLE unconditionally** (it needs that
  attribute; only ALTER when the role has it). Local dev + CI: a superuser container, never the shared server.
- **App privileges are narrower than v1** (`app/db/grants.py`): v1 `authenticated` grants minus
  TRUNCATE/TRIGGER/REFERENCES/MAINTAIN (RLS does not govern them), and INSERT/UPDATE/DELETE only
  where a policy for that command exists. All meeting content is SELECT-only for the app, so
  **editor-level writes are enforced in the API** (`can_access_meeting(..., 'editor')`) and executed
  as `ricotdin_service`. PUBLIC has no TEMP on the database and no CREATE in `public`; functions
  later created by the migrating role are not PUBLIC-executable by default (tested). v1 policies without `TO`
  are scoped `TO ricotdin_app`. SECURITY DEFINER functions use `search_path = public, pg_temp`.
  R2 never serve requests as the table owner (owner bypasses RLS; no FORCE RLS) — assert at startup.
  R3 set the context per transaction only: `set_config('app.user_id', $1, true)` + `app.role` inside
  an explicit transaction (Neon pooler = PgBouncer transaction mode; session SET would leak).
  R4 bind parameters, never string-built `SET`. R5 values only from the verified token (`sub`) and
  `users.role`; whitelist role `user|admin`; set both or neither. R6 reset/roll back connections on
  check-in; test that a reused connection has no context. R7 statement/lock timeouts and connection
  limits per role. R8 no CREATE/TEMP for the app role (done in the schema).

From §0.4 (`docs/architecture/platform-services.md`):

  - **Callers must check ownership first** (`owned_audio_path` / `is_owned_audio_key` /
    `is_owned_avatar_key`); storage accepts any key (≤ 121 bytes, the Drive appProperty limit).

From §0.7 (`docs/architecture/worker.md`):

  `gemini-embedding-001`, 768 dims, pinned: changing it means re-embedding every meeting),

From v1 §5 / §6 (`docs/architecture/v1-rules.md`; the same rules bind v2 per §0):

  **The Gemini API key and the Supabase service role key must NEVER reach the browser.**
- Any server code that signs, downloads or deletes a storage key read from a DB row MUST check the key
  belongs to that row: `ownedAudioPath` / `isOwnedAudioKey` (meetings), `isOwnedAvatarKey` (profiles).
- Every `SECURITY DEFINER` function MUST `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` and grant
  only the roles that need it. "No GRANT" does NOT mean "not callable": Postgres grants EXECUTE to
  PUBLIC by default (BUG-005, migration 034). Exceptions: trigger functions (not callable via PostgREST)
  and `can_access_meeting`, which RLS policies call as `authenticated` and which only answers for
  `auth.uid()` (it keeps EXECUTE; see BUG-005).
- Embedding dimension is **768** and must match the `output_dimensionality` we
  request from Gemini's embedding model. Do not change one without the other.


## 9k. Release process

Full detail: `docs/architecture/release-cutover.md` (§0.11); owner runbooks in `docs/ops/`.

**Branches** (GitHub default branch = `main` since 2026-11-12 (owner decision, ARC-19), so fresh clones
land on `main`, a bare `gh pr create` targets `main`, and `schedule` workflows run
from `main` — always pass `--base` explicitly; day-to-day PRs still go into `dev`):
- `dev` — day-to-day work.
- `main` — stable integration branch; only receives PRs from `dev` (and hotfix merge-backs).
- `release/X.Y` — one branch per minor version line, cut from `main`. Receives **bugfixes
  only**, never new features. All `vX.Y.Z` tags live here.
- `release/1.1` — v1, retired (ARC-20): nothing is released from it any more.
  **Never merge `release/1.1` into `main` or `dev`**: it has v1 at the repo root and would bring
  the deleted v1 code back.

**Versioning:** SemVer. `app/api/pyproject.toml` and `app/web/package.json` `version` MUST both equal
the tag without the `v`; `release.yml` rejects a tag that does not match, whose major is < 2, or whose
commit is not on `release/X.Y`.

**New minor/major release `X.Y.0`:**
1. On `dev`: the api and web commands in §0 are green.
2. Bump both version files to `X.Y.0`; add a `## [X.Y.0]` section to `CHANGELOG.md`
   (features + deploy checklist: new Alembic revisions, new env vars, manual steps + known issues).
3. Commit `chore(release): vX.Y.0`, PR `dev` → `main` (`gh pr create --base main --head dev`), merge (merge commit, not squash) after CI is green.
4. Cut the branch: `git checkout main && git pull && git checkout -b release/X.Y && git push -u origin release/X.Y`.
5. Tag on it: `git tag -a vX.Y.0 -m "Release vX.Y.0" && git push origin vX.Y.0`
   → `release.yml` runs both CI suites, pushes `mingming21400/ricotdin-api:vX.Y.0` and
   `mingming21400/ricotdin-web:vX.Y.0` (+ `latest` if highest) and opens PR `ricotdin vX.Y.0` on
   `mmlabs-online/deployment` (see Deploy below). A prerelease tag (`vX.Y.0-rc1`) only pushes images.
6. Create the GitHub Release from the `CHANGELOG.md` section.

**Hotfix `X.Y.(Z+1)`:**
1. Branch from `release/X.Y` (e.g. `hotfix/BUG-NNN-<topic>`), fix + test, bump both versions, add CHANGELOG entry.
2. PR into `release/X.Y`; after merge, tag `vX.Y.(Z+1)` on `release/X.Y` and push the tag.
3. Merge `release/X.Y` back into `main` and `dev` so the fix is not lost in the next release
   (X ≥ 2 only — never `release/1.1`, see above). `latest` only moves when the pushed tag is the
   highest version, so a hotfix on an old line never drags `latest` backwards.

**Deploy = merge the deployment PR (OPS-04):** the PR writes ONLY `apps/ricotdin-v2/release.env`
(`RICOTDIN_API_IMAGE`, `RICOTDIN_WEB_IMAGE`, both `:tag@digest`, + `RICOTDIN_VERSION`); runtime
secrets are `RICOTDIN_*` repository secrets of the deployment repo, written to the server env files by
each deploy, never committed anywhere. The secret `DEPLOY_REPO_TOKEN` is a
fine-grained PAT on `mmlabs-online/deployment` only (Contents + Pull requests RW). The version is
served by public `GET /version.json`; `GET /health` backs the image `HEALTHCHECK`. Never deploy
`dev` or `latest`. Run that release's `alembic upgrade head` (on the Mac, `docs/ops/self-hosted-postgres.md`)
BEFORE merging the deployment PR.
Rollback = a deployment PR pinning the previous release's digests (only safe if no destructive
migration ran in between).

## 9l. Traceability (feature / bug ↔ branch ↔ commit ↔ PR)

Tickets live **in the repo only** — no GitHub Issues. Features: `ai-instruction/tracking.md`
(`ABC-12`). Bugs: `ai-instruction/bugs.md` (`BUG-NNN`). Linking is by convention (no CI check);
the `/add-feature`, `/ship-feature` and `/fix-bug` skills apply it automatically.

| Artifact | Convention |
|---|---|
| Branch | `feat/<CODE>-<slug>` · `fix/BUG-NNN-<slug>` (from `dev`) · `hotfix/BUG-NNN-<slug>` (from `release/X.Y`) · `docs/<CODE>-<slug>` |
| Commit | Conventional Commits with the code at the end: `feat(rag): folder export (RAG-05)`, `fix(quota): no double charge (BUG-004)` |
| PR title | `[<CODE>] <summary>`; body from `.github/pull_request_template.md` |
| Release PR | `chore(release): vX.Y.Z`; body lists every code included (command below) |
| CHANGELOG | each bullet ends with its code(s): `- … (PRO-09)` |
| Back-link | after a PR is opened, add `PR #N` to the Note cell in `tracking.md` / the Link cell in `bugs.md` |

Look-ups:
```
git log --oneline --grep 'PRO-09'                         # commits for a code
gh pr list --state all --search 'PRO-09 in:title'          # PRs for a code
git log main..dev --format=%s | grep -oE '\b[A-Z]+-[0-9]+\b' | sort -u   # codes in the next release
```

## 10. Working agreement (how to collaborate with me)

- Work in **small increments**, one clear goal per change, each with a concrete
  "done" check. Do not attempt the whole app in one go.
- After each working increment, **commit to git** with a clear message.
- **TDD is mandatory for all new logic:**
  - Write unit tests for every new pure function **before** writing the implementation.
  - Test locations and commands: §0.
  - When **any existing logic changes**, update the corresponding tests first, then
    change the implementation.
  - Unit tests must be pure (no I/O, no mocks) — test pure functions; DB/network only in `test_*_integration.py`.
- **Update `ai-instruction/tracking.md`** when a feature is completed: change `[ ]`
  to `[x]` in the "Is Done?" column for every Feature Code that the work covers.
- Before making large or structural changes, briefly state the plan and wait.
- When you hit an error, surface the exact error/log rather than guessing silently.
- If a request seems to contradict this file (e.g. would expose a key to the client,
  or pull in an out-of-scope feature), flag it instead of just doing it.
- **Feature intake workflow:** to turn a new idea into a tracked feature, use the
  `/add-feature "<idea>"` skill (`.claude/skills/add-feature/SKILL.md`): ground in repo
  (dedupe/scope/code) → brainstorm Q&A → 2–3 options + recommendation → converge on the
  smallest valuable slice that passes a Definition of Ready (testable criteria, test plan,
  structural flags, done check) → approved spec → write `tracking.md` + `features/*.md`
  (no DB seeder in v2: add the code at `/admin/features` by hand). Docs only, no code.
- **Feature delivery workflow:** to build a feature from `tracking.md`, use the
  `/ship-feature <CODE>` skill (`.claude/skills/ship-feature/SKILL.md`). It sequences
  spec → plan → TDD → implement → verify → specialist review gates (subagents in
  `.claude/agents/`) → close-out → pushes `feat/<CODE>-<slug>` and opens a PR into `dev`
  automatically (draft if checks are open; never merges). Applies the rules in this section.
- **Bug workflow:** for any bug, regression or production incident, use the
  `/fix-bug "<description>"` skill (`.claude/skills/fix-bug/SKILL.md`). It logs `BUG-NNN` in
  `ai-instruction/bugs.md`, decides bugfix (`dev`) vs hotfix (`release/X.Y`, per §9k) with
  your confirmation, writes a failing regression test first, then fixes, verifies, reviews
  and walks through the §9k hotfix steps.
- **Traceability:** every branch, commit, PR title and CHANGELOG bullet carries its feature
  code or `BUG-NNN` (§9l).
- **Owner copilot:** `/copilot` (status brief), `/copilot <question>`, `/copilot plan`
  (`.claude/skills/copilot/SKILL.md`). Advises and plans only; uses the read-only
  `Project Status Analyst` agent and `tracking.md` for facts. Strategy and
  decisions persist in `ai-instruction/roadmap.md` (written only with owner approval).
