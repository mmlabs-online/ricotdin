# CLAUDE.md

Project memory for Claude Code. Read this fully at the start of every session.
Keep it updated as the project evolves — this file is the source of truth.

## 0. v2 re-platform (module ARC) — read first

The repo is mid-migration (roadmap 2026-10-25; specs in `ai-instruction/features/feature-Architecture-ARC.md`,
progress in `ai-instruction/tracking.md` ARC rows). Since **ARC-00**:

```
legacy/          v1 — the Next.js + Supabase app described in §1–§11 (frozen: hotfixes only, release/1.1)
app/api/         v2 backend — FastAPI, Python 3.12, uv (ARC-02..ARC-10)
app/web/         v2 frontend — Vite + React SPA (Figma Make import in ARC-11)
ai-instruction/  shared: tracking, features, bugs, roadmap, ai-gen/ (runtime pipeline prompt)
docs/  .claude/  .github/  CLAUDE.md  CHANGELOG.md  README.md   shared
```

- **Every v1 path in §1–§11 is relative to `legacy/`** (`lib/gemini` = `legacy/lib/gemini`,
  `migrations/` = `legacy/migrations/`, `tests/` = `legacy/tests/`). v1 rules still apply to v1 code.
- **v1 commands run inside `legacy/`** (`cd legacy && npm run dev|test|…`, `npx tsx scripts/…`).
  `legacy/.env.local` holds the v1 env; an optional corporate CA goes in `legacy/certs/`
  (`legacy/instrumentation-node.ts` reads `<cwd>/certs/`). `ai-instruction/` is resolved from `legacy/` or the image root by
  `legacy/lib/paths/shared.ts`. v1 image: `docker build -f legacy/Dockerfile .` **from the repo root**
  (context must include `ai-instruction/ai-gen/`).
- **v2 commands:**
  - api: `cd app/api && uv sync && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest -q`
  - web: `cd app/web && npm ci && npm run typecheck && npm test && npm run build`
- **TDD for v2 (same rule as §10, different place):** pure logic first, tests before implementation.
  api → `app/api/tests/test_<topic>.py` (pytest, no network/DB unless it is an explicit integration test
  named `test_*_integration.py`); web → `app/web/src/**/<name>.test.ts(x)` (vitest). v1 tests stay in
  `legacy/tests/*.test.ts` + `legacy/package.json` `test` script.
- **CI is path-filtered:** `ci.yml` (legacy + v1 image build/health), `ci-api.yml`, `ci-web.yml`.
- v2 security rules are the v1 rules (§5–§7, §9b, §9f, §9m) re-stated per ARC spec; secrets stay server-only.
- (ARC-19) §1–§9 (v1 commands), §9a–§9j, §9m–§9o and §11 now live in `legacy/CLAUDE.md`;
  §0.1–§0.11 live in `docs/architecture/` (table below).

### 0.x → file (ARC-19)

The v2 design sections live in `docs/architecture/`. Code comments that cite "CLAUDE.md §0.x" resolve
through this table. **Read the file before working in that area**; its rules are binding.

| § | File | Read before working on |
|---|---|---|
| §0.1 | `docs/architecture/db.md` | Neon schema, Alembic, DB roles, RLS request context, grants |
| §0.2 | `docs/architecture/api-runtime.md` | FastAPI factory, middleware, logins/pools, `Database` session, image |
| §0.3 | `docs/architecture/auth.md` | register/login/refresh, passwords, JWT, email tokens |
| §0.4 | `docs/architecture/platform-services.md` | crypto, key pool, app config, Google Drive / R2 storage |
| §0.5 | `docs/architecture/data-migration.md` | v1 → v2 data + file migration (Supabase → Neon, R2 → Drive) |
| §0.6 | `docs/architecture/core-domain-api.md` | meetings, folders/shares, content, profile, quota routes |
| §0.7 | `docs/architecture/worker.md` | pipeline worker, transcription, AI analyse, embed, schedulers |
| §0.8 | `docs/architecture/chat-rag.md` | chat sessions, retrieval scope, grounded answers, citations |
| §0.9 | `docs/architecture/admin-api.md` | admin users, operations, configuration endpoints |
| §0.10 | `docs/architecture/web.md` | SPA foundation, routing, auth in the browser, i18n, screens |
| §0.11 | `docs/architecture/release-cutover.md` | v2 release, supply chain, backup, cutover |

v1 sections (§1–§9 commands, §9a–§9j, §9m–§9o, §11) live in `legacy/CLAUDE.md`, loaded when working
under `legacy/`.

### Never (verbatim excerpts; the full rule is in the cited file)

From §0 (above):

- v2 security rules are the v1 rules (§5–§7, §9b, §9f, §9m) re-stated per ARC spec; secrets stay server-only.

From §0.1 (`docs/architecture/db.md`):

  The old us-east-2 project `lucky-king-55263595` is unused. Local `app/api/.env` holds `DATABASE_URL`
  (dev branch, **direct** connection, never pooled for migrations/tests); never commit or print it.
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

From v1 §5 / §6 (`legacy/CLAUDE.md`; the same rules bind v2 per §0):

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

**Branches** (GitHub default branch = `main` since 2026-11-12 (owner decision, ARC-19), so fresh clones
land on `main`, a bare `gh pr create` targets `main`, and `schedule` workflows (e.g. `backup.yml`) run
from `main` — always pass `--base` explicitly; day-to-day PRs still go into `dev`):
- `dev` — day-to-day work; every push → Docker image `ricotdin:dev` (`release-dev.yml`).
- `main` — stable integration branch; only receives PRs from `dev` (and hotfix merge-backs).
- `release/X.Y` — one branch per minor version line, cut from `main`. Receives **bugfixes
  only**, never new features. All `vX.Y.Z` tags live here (`v1.0.0`, `v1.0.1`… on `release/1.0`).
- `ci.yml` runs on push/PR to `main`, `dev` and `release/**` (on `dev` informational only — not a required check; OPS-06).

**Versioning:** SemVer. `package.json` `version` MUST equal the tag without the `v` — since ARC-00 that
file is **`legacy/package.json`** (run `npm version` inside `legacy/`).
`release.yml` rejects a tag that does not match `legacy/package.json` or whose commit is not on
`release/X.Y` (the branch matching the tag's major.minor).

**New minor/major release `X.Y.0`:**
1. On `dev`: `npm run lint && npm run typecheck && npm run test && npm run build`.
2. `npm version X.Y.0 --no-git-tag-version`; add a `## [X.Y.0]` section to `CHANGELOG.md`
   (features + deploy checklist: new migrations, new env vars, dashboard steps + known issues).
3. Commit `chore(release): vX.Y.0`, PR `dev` → `main` (`gh pr create --base main --head dev`), merge (merge commit, not squash) after CI is green.
4. Cut the branch: `git checkout main && git pull && git checkout -b release/X.Y && git push -u origin release/X.Y`.
5. Tag on it: `git tag -a vX.Y.0 -m "Release vX.Y.0" && git push origin vX.Y.0`
   → `release.yml` pushes `mingming21400/ricotdin:vX.Y.0` (+ `:latest` if highest) and opens
   PR `ricotdin vX.Y.0` on `mmlabs-online/deployment` (OPS-04, see Deploy below).
6. Create the GitHub Release from the `CHANGELOG.md` section.

**Hotfix `X.Y.(Z+1)` for an existing line:**
1. Branch from `release/X.Y` (e.g. `hotfix/<topic>`), fix + test, bump version, add CHANGELOG entry.
2. PR into `release/X.Y`; after merge, tag `vX.Y.(Z+1)` on `release/X.Y` and push the tag.
3. Merge `release/X.Y` back into `main` and `dev` so the fix is not lost in the next release.
   `ricotdin:latest` only moves when the pushed tag is the highest version, so a hotfix on
   an old line never drags `latest` backwards.
   **After ARC-00:** `release/1.1` (and tags ≤ v1.1.1) still has v1 at the repo root, while `dev`/`main`
   have it in `legacy/`. Merging back relies on git rename detection: edits to moved files follow them,
   but a file **added** on `release/1.1` (new test, new migration) may land at the root or raise a
   directory-rename conflict — after the merge, check every new file sits under `legacy/` and that
   `legacy/package.json` has the hotfix version.

**Step-by-step for the owner:** `docs/ops/release-runbook.md` (OPS-07) — one-time hand deploy +
per-release order (migrations → deploy → `npm run verify:deploy`).

**Deploy = merge the deployment PR (OPS-04):** image `mingming21400/ricotdin`, tags are
v-prefixed (`vX.Y.Z`). After `verify` passes, `release.yml` builds + pushes the image, then
(secret `DEPLOY_REPO_TOKEN` — fine-grained PAT on `mmlabs-online/deployment` only, Contents +
Pull requests RW) opens PR `ricotdin vX.Y.Z` on `mmlabs-online/deployment` that writes ONLY
`apps/ricotdin/release.env`:
`RICOTDIN_IMAGE=mingming21400/ricotdin:vX.Y.Z@<digest>` (pinned by digest) + `RICOTDIN_VERSION=vX.Y.Z`.
Reviewing + merging that PR deploys to the home server (deployment-repo side = OPS-05: drafts in
`docs/ops/deployment-repo/` — `apps/ricotdin/compose.yml`, `deploy-ricotdin.yml`, README with the
verification prompt; runtime secrets ONLY in the server file `/etc/mmlabs/ricotdin.env`, never in a repo).
The tag is never baked into the image; runtime `RICOTDIN_VERSION` (non-secret) is served by
public `GET /version.json` (fallback: baked `BUILD_COMMIT`, then `"unknown"` —
`lib/release/version.ts`). Public `GET /api/health` → `{"status":"ok"}` (no DB/provider calls)
backs the image `HEALTHCHECK`. Never deploy `dev` or `latest`. Apply that release's new
migrations BEFORE merging the deployment PR. Rollback = a deployment PR pinning the previous
release's digest (only safe if no destructive migration ran in between).

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
  - Tests go in `tests/` with the `.test.ts` extension and must be added to the
    `npm test` script in `package.json` (v1: `legacy/tests/`, `legacy/package.json`; v2 locations: §0).
  - When **any existing logic changes**, update the corresponding tests first, then
    change the implementation.
  - Tests must be pure (no I/O, no mocks) — test pure functions extracted into `/lib`.
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
  → `seed-features.ts --only <CODE>`. Docs only, no code.
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
  `Project Status Analyst` agent and `scripts/backlog-snapshot.ts` for facts. Strategy and
  decisions persist in `ai-instruction/roadmap.md` (written only with owner approval).
