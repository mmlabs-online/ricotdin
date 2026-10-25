---
name: fix-bug
description: Fix a bug end to end — intake and log it in ai-instruction/bugs.md (BUG-NNN), decide bugfix (on dev) vs hotfix (on release/X.Y for a shipped version), reproduce with a failing regression test first, minimal fix, verify, review gates, then close-out (bug log, CHANGELOG, version bump for hotfixes) and the release steps from CLAUDE.md §9k. Use when the user reports a bug, error, regression, or production incident, or asks for a hotfix.
argument-hint: "<bug description, error message, or BUG-NNN>"
---

# Fix a bug (report → regression test → fix → bugfix or hotfix)

Bugs are tracked **in the repo only** (`ai-instruction/bugs.md`; no GitHub Issues).
Traceability follows `CLAUDE.md` §9l. `CLAUDE.md` always wins on conflict.

Input: `$ARGUMENTS` — a description / error / log, or an existing `BUG-NNN` to resume.
Talk to the user in their language; write bugs.md and code in English.

Subagents are called with the Agent tool; `subagent_type` is the agent's frontmatter `name`.
Reviewers are read-only; the main session fixes.

---

## Step 1 — Intake

1. If `$ARGUMENTS` is `BUG-NNN`, load its row + details from `ai-instruction/bugs.md` and
   resume at the step matching its status.
2. Otherwise collect, in **one** AskUserQuestion round at most (skip what you already have):
   steps to reproduce, expected vs actual (exact error text), **where** it happens
   (production `vX.Y.Z` / `dev` / local), and how bad it is.
3. Gather evidence yourself before asking more: grep the error text in the code, check
   `meetings.error_message` / logs the user pasted, `git log -S` for recent changes nearby.
4. Duplicate check: search `bugs.md` for the same symptom → if found, resume that bug instead.
5. If it's actually missing behaviour (never specified), it's a feature, not a bug — suggest
   `/add-feature` and stop.

## Step 2 — Log it

Assign the next `BUG-NNN` (highest in `bugs.md` + 1, three digits). Add a table row with
status `open` and a `## BUG-NNN — <Title>` details section (template at the bottom of
`bugs.md`). Severity per the definitions in the `bugs.md` header. Link the related feature
code from `tracking.md` if there is one.

## Step 3 — Bugfix or hotfix? ✋

Find whether the faulty code is in a released version:

```
git tag -l 'v*' --sort=-v:refname          # released versions
git branch -r --list 'origin/release/*'     # release lines
git log origin/release/X.Y --oneline -- <file>   # is the faulty code on that line?
```

- **Hotfix** — the bug is in a version running in production (`vX.Y.Z` on `release/X.Y`)
  **and** severity is S1/S2 (or the user explicitly wants it shipped now).
- **Bugfix** — everything else: bug only on `dev`, or S3/S4 that can wait for the next release.

State the decision with the reason and the target line (`release/X.Y`), and **wait for the
user to confirm**. Record `Fix type` in `bugs.md`; set status `in_progress`.

## Step 4 — Branch

Working tree must be clean (or the user confirms the changes belong here).

- Bugfix: `git checkout dev && git pull && git checkout -b fix/BUG-NNN-<slug>`
- Hotfix: `git checkout release/X.Y && git pull && git checkout -b hotfix/BUG-NNN-<slug>`

Never commit directly to `main` or `release/*`.

## Step 5 — Reproduce with a failing test (mandatory)

1. Locate the root cause. **Codebase Archaeologist** may help in an unfamiliar or drifted area.
2. Write the regression test **first** in `tests/<topic>.test.ts` (pure, no I/O, no mocks —
   `CLAUDE.md` §10). Name it after the symptom, e.g. `"BUG-007: does not double-charge on retry"`.
   If the faulty logic isn't in a pure function yet, extract the smallest pure function that
   contains it, then test that. New test file → add it to the `test` script in `package.json`.
   **Where (CLAUDE.md §0):** v1 code in `legacy/` → the paths below are under `legacy/`, run from `legacy/`.
   v2 api → `app/api/tests/test_<topic>.py` (pytest; run `cd app/api && uv run pytest -q tests/test_<topic>.py`).
   v2 web → `app/web/src/**/<name>.test.ts(x)` (vitest; `cd app/web && npx vitest run <file>`).
3. Run it and confirm it **fails for the bug's reason** (paste the failure).
4. Only if the bug truly can't be expressed as a pure test (pure CSS/layout, browser API,
   provider behaviour): write the manual repro steps in the bug's details, capture evidence
   (**Evidence Collector** for UI), and say explicitly that there's no automated test and why.

Write the root cause into the bug's details section.

## Step 6 — Fix

Smallest change that makes the test pass — **Minimal Change Engineer** discipline.
No refactors, renames, or "while I'm here" changes; note those as follow-ups instead.

Hotfix extra rules:
- No new features, no dependency upgrades unless the dependency *is* the bug.
- Avoid migrations. If one is unavoidable it must be backwards-compatible (additive), and
  the deploy note must say "apply migration before starting the new image".

## Step 7 — Verify

Run the set for every area the change touches (CLAUDE.md §0):

```
cd legacy  && npm run lint && npm run typecheck && npm run test && npm run build   # v1
cd app/api && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest -q   # v2 api
cd app/web && npm run typecheck && npm test && npm run build   # v2 web
```

Paste the exact output of any failure. Re-run the original repro (manual or test) and
confirm it now passes.

## Step 8 — Review gates (parallel, read-only)

| Gate | Agent | When |
|---|---|---|
| Correctness, regressions | **Code Reviewer** | always |
| RLS, secrets, authz | **AI-Generated Code Security Auditor** | touches `legacy/app/api/**`, `legacy/migrations/**`, `legacy/lib/{access,keys,crypto}`, `app/api/**` (v2: routers, auth, DB/Alembic, crypto, keys), auth |
| Verdict | **Reality Checker** | always, last — give it the failing-then-passing test output |

Fix confirmed findings → back to Step 7. Max 2 rounds; report what's still open.

## Step 9 — Close-out & commit

1. `bugs.md`: status `fixed`, `Fixed in` = `dev` (bugfix) or the new `X.Y.Z` (hotfix),
   `Link` = branch name; fill **Fix** in the details (incl. the regression test name).
2. Hotfix only:
   - `npm version X.Y.(Z+1) --no-git-tag-version`
   - `CHANGELOG.md`: new `## [X.Y.(Z+1)] — YYYY-MM-DD` section with `### Sửa lỗi`
     (`- <what was broken, user-visible> (BUG-NNN)`) and a deploy checklist if there is a migration.
3. Bugfix only: `CHANGELOG.md` → `## [Unreleased]` → `### Sửa lỗi` → `- … (BUG-NNN)`
   (create the section above the latest release if missing).
4. Commit: `fix(<scope>): <summary> (BUG-NNN)`. Do not push yet.

## Step 10 — Ship ✋ (every outward step needs the user's go-ahead)

**Bugfix**
1. Push `fix/BUG-NNN-<slug>` and open a PR into `dev`, or merge into `dev` locally if the
   user prefers. PR title: `[BUG-NNN] <summary>`; fill `.github/pull_request_template.md`.
   Always pass the base explicitly — never rely on the repo default branch (`dev` today, see
   CLAUDE.md §9k), so a bare `gh pr create` can never target the wrong branch:
   `gh pr create --base dev --head fix/BUG-NNN-<slug> --title "[BUG-NNN] <summary>" --body-file <file>`.
2. Record `PR #N` in the `Link` cell of `bugs.md`. It ships with the next normal release.

**Hotfix** (`CLAUDE.md` §9k "Hotfix")
1. Push `hotfix/BUG-NNN-<slug>`; PR into `release/X.Y`, title `[BUG-NNN] <summary>`
   (`gh pr create --base release/X.Y --head hotfix/BUG-NNN-<slug> …`).
   Record `PR #N` in `bugs.md`.
2. After it's merged: `git checkout release/X.Y && git pull && git tag -a vX.Y.(Z+1) -m "Release vX.Y.(Z+1)" && git push origin vX.Y.(Z+1)`
   → `release.yml` builds `ricotdin:X.Y.(Z+1)`.
3. Merge `release/X.Y` back into `main` **and** `dev` so the fix isn't lost. Resolve any
   conflict in favour of keeping both the fix and newer dev work; re-run Step 7 on `dev`.
4. Deploy is manual: pin `ricotdin:X.Y.(Z+1)`; apply any migration first.

## Final report

- `BUG-NNN`, severity, fix type + target line, root cause in one sentence.
- Regression test (name + fail→pass), or why there is none.
- Verify output, review verdict, open follow-ups.
- What's left for the user: push/PR/tag/merge-back/deploy steps not yet done.
