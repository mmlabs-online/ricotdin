---
name: ship-feature
description: Deliver one feature from ai-instruction/tracking.md end to end — spec → plan → TDD → implement → verify → specialist review gates → close-out (tracking, docs, commit) → push the feat/ branch and open a PR into dev. Use when asked to build, implement, or "ship" a feature code like REC-06 or ADM-08, or to pick the next unfinished feature.
argument-hint: <FEATURE-CODE> | next
---

# Ship a feature (tracking.md → dev)

Standard delivery workflow for this repo. It wires the subagents in `.claude/agents/`
into the working agreement in `CLAUDE.md` §10. `CLAUDE.md` always wins on conflict.

Input: `$ARGUMENTS` — a feature code (e.g. `PRV-02`) or `next`.

Subagents are called with the Agent tool; `subagent_type` is the agent's frontmatter
`name` (e.g. `Code Reviewer`). Give every subagent the feature code, the spec excerpt,
the file list, and tell it to follow `CLAUDE.md`. Reviewers are **read-only**: they report,
the main session fixes.

---

## Phase 0 — Select & preflight

1. Branch: work always happens on `feat/<CODE>-<slug>` cut from an up-to-date `dev`
   (`git checkout dev && git pull && git checkout -b feat/<CODE>-<slug>`) — the PR opened in
   Phase 7 needs a branch other than `dev`. If already on that feature branch, keep it.
   Never work on `main` or `release/*`; if on any other branch, stop and ask.
2. Working tree must be clean, or the user confirms the existing changes belong to this work.
3. If `$ARGUMENTS` is `next`: list `[ ]` rows from `ai-instruction/tracking.md` whose
   dependencies are all `[x]`, and let **Sprint Prioritizer** rank them (Blocker > Mandatory >
   rest; *SaaS* last). Ask the user to pick one. Do not start without a chosen code.

**Exit:** one feature code, its dependencies all done.

## Phase 1 — Understand the spec

1. Read the feature's row in `ai-instruction/tracking.md` (user story, description,
   constraint, note) and its `### <CODE>` section in `ai-instruction/features/feature-*-<PREFIX>.md`.
2. Read the relevant `CLAUDE.md` sections (§5 conventions, §6 DB, §7 Gemini, and any
   §9x design section for the module).
3. Check scope against `CLAUDE.md` §1 "Explicitly OUT of MVP scope". If the feature needs
   something out of scope, stop and flag it.
4. For an unfamiliar or drifted area, **Codebase Archaeologist** may map the current code
   (read-only).

Specs written by `/add-feature` already carry **Acceptance Criteria**, **Test Plan**,
**Structural flags** and **Done check** — use them as the baseline for Phases 2–3 and only
re-derive what's missing. If the spec is vague (no testable criteria), suggest refining it
with `/add-feature` first rather than guessing.

**Exit:** you can state the acceptance criteria in 3–6 bullets.

## Phase 2 — Plan (wait for approval when structural)

Write a short plan: files to touch, new pure functions + their tests, migrations,
new env vars, UI changes, and the concrete "done" check.

Optional design consults (read-only, only when the trigger applies):

| Trigger | Agent |
|---|---|
| New table, migration, RLS policy, index | **Database Optimizer** |
| New service boundary, provider, background job | **Software Architect** |
| Retrieval / chunking / embeddings (`lib/rag`, `lib/pipeline/chunk*`) | **RAG Pipeline Engineer** |
| Gemini prompts (`lib/gemini`, `ai-instruction/ai-gen/`) | **Prompt Engineer** |
| New page or major UI flow | **UX Architect** |

**Structural change** = new migration, new env var, new API route family, a change to
auth/RLS/keys, or more than ~10 files. For a structural change, present the plan and
**wait for the user's go-ahead** (`CLAUDE.md` §10). Otherwise state the plan and continue.

## Phase 3 — Tests first (TDD, mandatory)

1. Extract the new logic as **pure functions** in `/lib` (no I/O).
2. Write `tests/<topic>.test.ts` (node:test + tsx, no mocks, no I/O) **before** the
   implementation. When changing existing logic, update its tests first.
3. Add the new file to the `test` script in `package.json`.
4. Run `node --import tsx --test tests/<topic>.test.ts` and confirm it **fails** for the
   right reason.

   **Where (CLAUDE.md §0):** v1 code in `legacy/` → the paths below are under `legacy/`, run from `legacy/`.
   v2 api → `app/api/tests/test_<topic>.py` (pytest; run `cd app/api && uv run pytest -q tests/test_<topic>.py`).
   v2 web → `app/web/src/**/<name>.test.ts(x)` (vitest; `cd app/web && npx vitest run <file>`).

Note: **Test Automation Engineer** targets Playwright/Cypress e2e. This repo has no e2e
suite, so do not use it for this phase.

## Phase 4 — Implement

The main session implements, following the **Minimal Change Engineer** discipline:
smallest diff that satisfies the acceptance criteria, no drive-by refactors.

Delegate a self-contained slice to a specialist only when it clearly helps
(e.g. **Frontend Developer** for a component, **RAG Pipeline Engineer** for retrieval).
Hard rules regardless of who writes the code:

- Gemini is called **only** through `/lib/gemini`.
- `GEMINI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `KEY_ENCRYPTION_SECRET` and decrypted keys
  never reach the browser or logs.
- Typed errors in `/lib`, mapped to HTTP in routes; friendly user messages.
- New migrations: next number in `migrations/`, `snake_case`, RLS on.
- Admin routes use `requireAdmin`; meeting routes use `checkMeetingAccess`.

## Phase 5 — Verify

Run them all and paste the exact output of any failure (do not summarize it away).
Run the set for every area the change touches (CLAUDE.md §0):

```
cd legacy  && npm run lint && npm run typecheck && npm run test && npm run build   # v1
cd app/api && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest -q   # v2 api
cd app/web && npm run typecheck && npm test && npm run build   # v2 web
```

Everything green before Phase 6. If the feature has UI or an API route, also exercise it in
the running app (`/run` skill) and note what you saw.

## Phase 6 — Review gates (parallel, read-only)

Launch the applicable reviewers **in one message** so they run concurrently. Give each the
diff (`git diff dev...HEAD` or the uncommitted diff) and the acceptance criteria.

| Gate | Agent | When |
|---|---|---|
| Correctness & maintainability | **Code Reviewer** | always |
| RLS, secrets, injection, authz | **AI-Generated Code Security Auditor** | touches `legacy/app/api/**`, `legacy/migrations/**`, `legacy/lib/{access,keys,crypto}`, `app/api/**` (v2: routers, auth, DB/Alembic, crypto, keys), auth |
| Credential handling | **Secrets & Credential Hygiene Engineer** | new/changed env vars or key storage |
| UI quality | **UI Finish-Gate Reviewer** | touches `legacy/components/**`, `legacy/app/(routes)/**` or `app/web/src/**` |
| Accessibility | **Accessibility Auditor** | new interactive UI |
| Ship / no-ship verdict | **Reality Checker** | always, **last**, given the Phase 5 output + the other reviewers' findings |

Handling findings:
- Fix every confirmed correctness/security finding, then return to **Phase 5**.
- Style-only or speculative findings: list them for the user; don't silently apply.
- Stop after 2 review rounds; report what is still open instead of looping.

**Exit:** Reality Checker verdict is not "NEEDS WORK", or the user accepts the open items.

## Phase 7 — Close out

1. `ai-instruction/tracking.md`: set **Is Done?** to `` `[x]` `` for every feature code covered.
2. `ai-instruction/features/feature-*-<PREFIX>.md`: update the feature's **Status** line and
   key files.
3. DB feature registry: tell the user to update the status at `/admin/features`.
   **Do not re-run `scripts/seed-features.ts`** — its upsert overwrites edits made in the UI.
4. `CLAUDE.md`: if the feature introduced a design worth remembering (new table, flag,
   env var, dashboard step), add/update the relevant §6 / §8 / §9x section. New migration →
   add it to §9a.
5. `CHANGELOG.md`: add a bullet under `## [Unreleased]` → `### Tính năng`, ending with the
   code: `- … (RAG-05)` (create the section above the latest release if missing). Note new
   migrations / env vars / dashboard steps for the deploy checklist.
6. Commit on the work branch (Conventional Commits with the code, e.g.
   `feat(rag): folder-scoped export (RAG-05)`), one commit per working increment.
7. **Open the PR automatically (final step, no extra confirmation)** — invoking
   `/ship-feature` authorizes pushing the `feat/` branch and opening a PR into `dev`.
   It never authorizes merging, pushing to `dev`/`main`/`release/*`, or force-pushing.
   1. `git push -u origin feat/<CODE>-<slug>`.
   2. Write the body from `.github/pull_request_template.md` to a scratchpad file: feature
      code(s), Type `feature`, what changed, the real Phase 5 results (tick only what actually
      passed; name anything not run and why), deploy notes (migrations, env vars, dashboard
      steps), the Phase 6 open findings + Reality Checker verdict, then the attribution line.
   3. `gh pr create --base dev --head feat/<CODE>-<slug> --title "[<CODE>] <summary>" --body-file <file>`.
      Add `--draft` when the Reality Checker said NEEDS WORK (user accepted the open items) or
      any Phase 5 command could not be run; say so in the body.
   4. Add `PR #N` to the Note cell of the feature's `tracking.md` row, commit
      (`docs(features): link <CODE> to PR #N`) and push the branch again.
   5. If push or `gh` fails (no auth, no network), stop and paste the exact error; the
      commits stay local. Conventions: `CLAUDE.md` §9l.

## Final report to the user

- Feature code(s) and what was delivered vs. the acceptance criteria.
- Verify output (pass/fail per command).
- Review gate results: fixed findings, open findings, Reality Checker verdict.
- Manual steps the user must do: migrations to apply, env vars, dashboard actions,
  `/admin/features` status update.
- The PR link (and whether it is a draft, and why).
- Next step: review + merge the PR into `dev` → PR `dev` → `main` → release per `CLAUDE.md` §9k
  (not part of this skill).
