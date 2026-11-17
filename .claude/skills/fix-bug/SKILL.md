---
name: fix-bug
description: Fix a bug end to end — intake and log it in ai-instruction/bugs.md (BUG-NNN), then ask the user to open a record-only PR (A), log more bugs in the same batch (B) or fix the batch now (C); decide bugfix (on main) vs hotfix (on release/X.Y.Z, the version in production), reproduce with a failing regression test first, minimal fix, verify, review gates, then close-out (bug log, CHANGELOG, version bump for hotfixes) and the release steps from CLAUDE.md §9k. Use when the user reports a bug, error, regression, or production incident, or asks for a hotfix.
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
   resume at the step matching its status (no new entry, no Step 2b question):
   - `open` (logged, e.g. by a record PR, option A) → `git fetch origin` and check the entry is
     on `origin/main`. If it is only on an open record PR, say so and ask whether to wait for the
     merge or branch from the record branch. Re-check the root cause against current `main`
     (code may have moved), then Step 3.
   - `in_progress` → Step 4 if its branch does not exist yet, else check out the branch in the
     `Link` cell and continue at Step 5 (or Step 6 if the regression test is already there).
   - `fixed` / `wontfix` / `duplicate` → report the state and stop.
2. Otherwise collect, in **one** AskUserQuestion round at most (skip what you already have):
   steps to reproduce, expected vs actual (exact error text), **where** it happens
   (production `vX.Y.Z` / `main` / local), and how bad it is.
3. Gather evidence yourself before asking more: grep the error text in the code, check
   `meetings.error_message` / logs the user pasted, `git log -S` for recent changes nearby.
   This investigation is **read-only** (no product code changes before the Step 2b choice): find
   the code path (`file:line`) and, if you can, reproduce it (an existing test, a one-off run).
4. Duplicate check: search `bugs.md` for the same symptom → if found, resume that bug instead.
5. If it's actually missing behaviour (never specified), it's a feature, not a bug — suggest
   `/add-feature` and stop.

## Step 2 — Log it

Assign the next `BUG-NNN` (highest in `bugs.md` + 1, three digits). Add a table row with
status `open` and a `## BUG-NNN — <Title>` details section (template at the bottom of
`bugs.md`). Severity per the definitions in the `bugs.md` header. Link the related feature
code from `tracking.md` if there is one. Fill **Root cause** with what Step 1 found, marked
**confirmed** (reproduced) or **suspected**, with `file:line`; "unknown" if nothing yet.
`Fix type` and `Fixed in` stay `—`; `Link` stays empty until a branch exists.

## Step 2b — Record only, record more, or fix now? ✋

Show the user every bug logged in this batch so far (ID, severity, one-line actual vs expected,
root cause confirmed/suspected) and ask with **AskUserQuestion** (in their language):

- **A. Open a record PR and stop** → Step 2c.
- **B. Log another bug** → ask for the next bug's description (plus screenshot/log) and end the
  turn. The user's next message is that bug: run Step 1 (incl. the duplicate check, now also
  against this batch) and Step 2 for it, appended to the same `bugs.md` changes, then ask Step 2b
  again. No need to type `/fix-bug` again.
- **C. Fix the whole batch now** → Step 3 onwards for **every** bug of the batch, S1 first, then
  in log order, one at a time (see "Batch fix" below).

An answer that is none of these: follow it if clear, else ask again.

## Step 2c — Record PR (option A)

Choosing A is the user's go-ahead to push and open this PR (Step 10's ✋ is satisfied for it).

1. Branch from the latest `main`: `git fetch origin && git checkout -b docs/BUG-NNN-<slug> origin/main`
   (§9l `docs/<CODE>-<slug>`; `BUG-NNN` = first bug of the batch). Not `fix/…`: that name is kept
   for the fix branch later. The branch holds **only** the `ai-instruction/bugs.md` changes.
2. Commit `docs(bugs): record BUG-NNN <short title>` (batch: `docs(bugs): record BUG-NNN, BUG-MMM`).
3. Push and open a PR into `main`, title `[BUG-NNN] Record: <short title>` (batch:
   `[BUG-NNN, BUG-MMM] Record: <summary>`), body from `.github/pull_request_template.md`
   (Type `chore`; What changed = per bug: severity, found in, actual vs expected, root cause
   confirmed/suspected with `file:line`; "Fix: `/fix-bug BUG-NNN` after merge"):
   `gh pr create --base main --head docs/BUG-NNN-<slug> --title "…" --body-file <file>`.
4. Back-link: `Link` cell of each bug = `record PR #N`; commit `docs(bugs): link record PR (BUG-NNN)`, push.
5. Report the PR link and stop. Status stays `open`; the fix starts later with `/fix-bug BUG-NNN`,
   which resumes from the logged entry (Step 1.1). Never merge the PR.

## Batch fix (option C)

Steps 3–9 run per bug, unchanged (each bug gets its own ✋ bugfix/hotfix confirmation and its own
failing regression test first). Grouping, because §9k sends bugfixes and hotfixes to different bases:

- **Bugfixes** share one branch `fix/BUG-NNN-<slug>` from `main` (`BUG-NNN` = first bugfix of the
  batch, e.g. `fix/BUG-009-010-…` when it is two), one commit per bug, and **one PR** into `main`
  titled `[BUG-NNN, BUG-MMM] <summary>`.
- **Hotfixes** cannot share that PR: they go to `release/X.Y.Z` (the version in production). All
  hotfixes of the batch share one `hotfix/BUG-NNN-<slug>` branch and one PR into it. Each needs its
  §9k merge-back.
- A bug whose fix is blocked (no repro, review gates still failing after 2 rounds) stays logged
  with its status; finish the others and list it in the final report.

So the batch ends in one PR, or one more per release line with hotfixes; say which before Step 4.

## Step 3 — Bugfix or hotfix? ✋

Find whether the faulty code is in a released version:

```
git tag -l 'v*' --sort=-v:refname          # released versions
git branch -r --list 'origin/release/*'     # release lines
git log origin/release/X.Y.Z --oneline -- <file>   # is the faulty code in that version?
```

- **Hotfix** — the bug is in a version running in production (`vX.Y.Z` = branch `release/X.Y.Z`, the highest tag)
  **and** severity is S1/S2 (or the user explicitly wants it shipped now).
- **Bugfix** — everything else: bug only on `main` (not released yet), or S3/S4 that can wait for the next release.

State the decision with the reason and the target (`release/X.Y.Z`), and **wait for the
user to confirm**. Record `Fix type` in `bugs.md`; set status `in_progress`.

## Step 4 — Branch

Working tree must be clean (or the user confirms the changes belong here).

- Bugfix: `git checkout main && git pull && git checkout -b fix/BUG-NNN-<slug>`
- Hotfix: `git checkout release/X.Y.Z && git pull && git checkout -b hotfix/BUG-NNN-<slug>`

In a batch (option C), only the first bug of each group creates the branch; later bugs of the
group continue on it. The uncommitted Step 2 `bugs.md` entries come along.

Never commit directly to `main` or `release/*`.

## Step 5 — Reproduce with a failing test (mandatory)

1. Locate the root cause. **Codebase Archaeologist** may help in an unfamiliar or drifted area.
2. Write the regression test **first** (pure, no I/O, no mocks — `CLAUDE.md` §10). Name it after
   the symptom, e.g. `test_bug_007_no_double_charge_on_retry` / `"BUG-007: does not double-charge on retry"`.
   If the faulty logic isn't in a pure function yet, extract the smallest pure function that
   contains it, then test that. A DB-level bug may use a `test_*_integration.py` test.
   **Where (CLAUDE.md §0):**
   api → `app/api/tests/test_<topic>.py` (pytest; run `cd app/api && uv run pytest -q tests/test_<topic>.py`).
   web → `app/web/src/**/<name>.test.ts(x)` (vitest; `cd app/web && npx vitest run <file>`).
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
cd app/api && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest -q   # v2 api
cd app/web && npm run typecheck && npm test && npm run build   # v2 web
```

Paste the exact output of any failure. Re-run the original repro (manual or test) and
confirm it now passes.

## Step 8 — Review gates (parallel, read-only)

| Gate | Agent | When |
|---|---|---|
| Correctness, regressions | **Code Reviewer** | always |
| RLS, secrets, authz | **AI-Generated Code Security Auditor** | touches `app/api/**` (routers, auth, DB/Alembic, crypto, keys), auth |
| Verdict | **Reality Checker** | always, last — give it the failing-then-passing test output |

Fix confirmed findings → back to Step 7. Max 2 rounds; report what's still open.

## Step 9 — Close-out & commit

1. `bugs.md`: status `fixed`, `Fixed in` = `main` (bugfix) or the new `X.Y.Z` (hotfix),
   `Link` = branch name; fill **Fix** in the details (incl. the regression test name).
2. Hotfix only:
   - No version bump: the version is the name of the release branch the owner cuts (OPS-09).
   - `CHANGELOG.md`: new `## [X.Y.(Z+1)] — YYYY-MM-DD` section with `### Sửa lỗi`
     (`- <what was broken, user-visible> (BUG-NNN)`) and a deploy checklist if there is a migration.
3. Bugfix only: `CHANGELOG.md` → `## [Unreleased]` → `### Sửa lỗi` → `- … (BUG-NNN)`
   (create the section above the latest release if missing).
4. Commit: `fix(<scope>): <summary> (BUG-NNN)`. Do not push yet.

## Step 10 — Ship ✋ (every outward step needs the user's go-ahead)

Agents never approve, merge or enable auto-merge on any PR; the owner merges.

**Bugfix**
1. Push `fix/BUG-NNN-<slug>` and open a PR into `main`. PR title: `[BUG-NNN] <summary>`; fill `.github/pull_request_template.md`.
   Always pass the base explicitly — never rely on the repo default branch (`main` since 2026-11-12, see
   CLAUDE.md §9k), so a bare `gh pr create` can never target the wrong branch:
   `gh pr create --base main --head fix/BUG-NNN-<slug> --title "[BUG-NNN] <summary>" --body-file <file>`.
2. Record `PR #N` in the `Link` cell of `bugs.md`. It ships with the next normal release.

**Hotfix** (`CLAUDE.md` §9k "Hotfix")
1. Push `hotfix/BUG-NNN-<slug>`; PR into `release/X.Y.Z`, title `[BUG-NNN] <summary>`
   (`gh pr create --base release/X.Y.Z --head hotfix/BUG-NNN-<slug> …`).
   Record `PR #N` in `bugs.md`. Merging it releases nothing (tag `vX.Y.Z` exists).
2. **Owner only** (the push deploys to production; agents never push `release/*`):
   `git checkout release/X.Y.Z && git pull && git checkout -b release/X.Y.(Z+1) && git push -u origin release/X.Y.(Z+1)`
   → `release.yml` tags `vX.Y.(Z+1)`, builds both images, merges the deployment PR (= deploy,
   migrations included) and creates the GitHub Release.
3. Merge `release/X.Y.(Z+1)` back into `main` so the fix isn't lost (a PR → `main`).
   Resolve any conflict in favour of keeping both the fix and newer `main` work; re-run Step 7 on `main`.

## Final report

- Per bug of the batch: `BUG-NNN`, severity, fix type + target line, root cause in one sentence.
- Regression test (name + fail→pass), or why there is none.
- Verify output, review verdict, open follow-ups.
- What's left for the user: push/PR/tag/merge-back/deploy steps not yet done.
