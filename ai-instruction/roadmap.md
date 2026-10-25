# Ricotdin — Roadmap & Strategy

> Owned by the project owner. Maintained through the `/copilot plan` skill
> (`.claude/skills/copilot/SKILL.md`) — Claude proposes, the owner decides, and only
> approved changes are written here.
> Items reference feature codes from `tracking.md` (and `BUG-NNN` from `bugs.md`).
> New work that has no code yet goes through `/add-feature` first.

## North star

Ricotdin is a meeting assistant our own team trusts with sensitive meetings: audio is purged
on a schedule, every release reaches the home server through one reviewed, health-checked,
reversible merge — on a v2 stack we control end to end (FastAPI API + SPA web, our own
Postgres and auth, no Supabase).

## Current goal

| Field | Value |
|---|---|
| Goal | **Re-platform to v2 (module ARC) and cut over with all data.** v1 is frozen: hotfixes only on `release/1.1`, no new v1 features, no v1 ops work beyond the safety net below. |
| Horizon | No fixed date. Checkpoints: **C1** after ARC-03 (data migration rehearsed), **C2** after ARC-10 (backend parity), **C3** after ARC-14 (UI parity) → ARC-15 cutover. |
| Success measures | (1) Every `[x]` feature is `done` on both API and FE in `ai-instruction/v2-tracking.md`. (2) Two data-migration rehearsals match 100% (ARC-03). (3) v2.0.0 live: Playwright smoke green on production, rollback tested on staging. (4) Until cutover, the nightly Supabase backup succeeds and one restore has been tested. |
| Constraints (people, time, budget) | All code by AI agents (`/ship-feature`, `/fix-bug`); owner approves and does dashboard/server steps (Neon project, SMTP, DNS, GitHub settings). Meetings contain **sensitive data**. Current (free-tier) AI keys accepted for all models (2026-10-23). **Low AI budget.** Production stays on its current v1 version until cutover. |

## Now (in progress / next up)

| Item | Codes | Why now | Done when |
|---|---|---|---|
| 1. Fix the backup: let the `backup` environment accept `dev` — owner (GitHub settings), agent runs it | OPS-03 | Scheduled runs use the default branch (`dev`) and never see the main-only secrets; ARC-03 reads production data with no safety net | `db-backup` run green on `dev`; one restore logged in `docs/ops/backup-restore.md`; OPS-03 `[x]` |
| 2. Apply migrations 034–038 on Supabase — owner | BUG-005, BUG-006, BUG-007, BUG-008, BUG-009, BUG-010 | Code-independent DB revokes close live holes whatever app version prod runs; v1.1.1 will not be deployed | Each file's verify query passes |
| 3. Close stale deployment PR #10 (`ricotdin v1.1.0`) — agent | OPS-05 | Merging it would pin `release.env` back to v1.1.0 | PR #10 closed with a note |
| 4. Docs drift — agent | `/fix-bug` (docs): CLAUDE.md §9k default branch = `dev`, §9o backup env includes `dev`, §11 v1.1.1 line; PRF-08 `[x]` (delivered by AIP-06) | Wrong docs mislead every agent run | CLAUDE.md + tracking match reality; bug logged + fixed |
| 5. Repo prep + legacy move — agent | ARC-00 | First ARC step; everything else builds on it | ARC-00 done check (CI green on legacy/api/web, v1 image builds from `legacy/`) |
| 6. v2 tracking matrix — agent | ARC-01 | Defines "parity" for every later step | Every `[x]` feature + every legacy route mapped |
| 7. Owner inputs for v2 — owner | ARC-02, ARC-05, ARC-11 | Unblock the next steps | Neon project (Singapore, pgvector) created; SMTP details ready; Figma Make source handed over |

## Next

| Item | Codes | Depends on |
|---|---|---|
| Neon schema (Alembic, own `users`, `profiles` kept, RLS on `app.user_id`) | ARC-02 | ARC-00, Now 7 |
| FastAPI core | ARC-04 | ARC-02 |
| Data migration script + 2 rehearsals → **checkpoint C1** | ARC-03 | ARC-02, Now 1 (backup) |
| Auth, platform services, core domain API, pipeline + worker, chat/RAG, admin API → **checkpoint C2** | ARC-05, ARC-06, ARC-07, ARC-08, ARC-09, ARC-10 | chain per `tracking.md` |
| Import Figma Make FE + port browser logic (parallel once ARC-05 OpenAPI is frozen) | ARC-11, ARC-12 | ARC-05, Now 7 |

## Later

| Item | Codes | Note |
|---|---|---|
| Wire user + admin screens → **checkpoint C3** | ARC-13, ARC-14 | Playwright smoke |
| Cutover v2.0.0 — includes v2 staging (Neon branch + 2 images, replaces OPS-02), the two-image deployment pipeline (replaces OPS-05 for v1), `pg_dump` backups, `x-forwarded-for` check on the proxy | ARC-15, OPS-02, OPS-05 | Rehearse the runbook on staging first |
| Remove legacy + decommission Supabase (after a stable period + final backup) | ARC-16 | Irreversible — owner confirms |
| After v2: account activity log, experience features, cost model, remaining profile features | PRF-09, PRO-04, PRO-05, CST-01, PRF-06, PRF-11, PRF-12 | Built only on v2 |

## Not doing (explicitly parked)

| Item | Reason | Revisit when |
|---|---|---|
| New v1 features (incl. PRF-09 on v1) | v1 frozen; would be ported twice | — (built on v2) |
| Deploy v1.1.1 / finish OPS-05 for v1 | Owner decision 2026-10-25: stop v1 ops, all effort on ARC; DB-level fixes go in via Now 2 | An S1 bug is found that needs app code on prod |
| OPS-02 staging on a second Supabase project | Supabase is being dropped | — (staging is part of ARC-15) |
| Read-only DB role for Supabase backups | Supabase-specific; v2 backups are `pg_dump` (ARC-15) | Cutover slips far |
| Commercialisation (COM-02, COM-03, COM-04), ADM-11, PRF-13 self-service | Internal use only; SaaS scope | Goal changes to opening up (Group A) or commercialising (Group B) |
| PRV-03 (superseded) | Purge delivered by PRV-02 (2026-10-21); audio encryption not needed while purge is on | Audio must be kept long-term |
| PRV-01 Enable Gemini billing (no-train) | Owner decision 2026-10-23: current keys for all models | Outside users, commercialisation, or a legal requirement |
| CST-02 as a separate item | Storage already on R2; legacy Supabase bucket retired by ARC-03 / ARC-16 | — |
| PRO-02 Google Calendar sync, PRO-03 reminders | Out of MVP scope (CLAUDE.md §1) | Explicit owner go decision |
| WebM remux, 39 lint warnings, in-memory login rate limit | Low impact; v2 rewrites these areas | Users complain / multi-instance deploy |

---

## Decision log

Newest at the bottom. One entry per decision; never edit past entries — add a new one that
supersedes it.

<!--
### YYYY-MM-DD — <decision title>
- **Decision:** ...
- **Options considered:** A ..., B ..., C ...
- **Why:** ...
- **Revisit if:** ...
-->

### 2026-10-21 — One month: stabilise for internal use, privacy first
- **Decision:** Strategy A — privacy first (PRV-01 billing, retention purge, recording notice), then the release/deploy path (OPS-04/05), DB backup, and a v1.1.0 release through the new pipeline. Internal users only.
- **Options considered:** A privacy first then ops (chosen); B ops first, privacy next month (sensitive meetings blocked meanwhile); C minimum — billing + deploy + backup only, audio kept forever.
- **Why:** Meetings will contain sensitive data and every pipeline step plus chat sends text to Gemini, so no-train terms (PRV-01) are unavoidable; the purge job reuses the existing `storage.audio_retention_days` setting and is cheap; the deploy path is already half built. Low AI budget is handled by monitoring `/admin/usage`, not by staying on the free tier.
- **Revisit if:** billing cost is higher than expected, the Supabase tier changes the OPS-03 shape, or the goal shifts to outside users.

### 2026-10-22 — Release v1.1.0 now; OPS-05 pipeline becomes v1.1.1
- **Decision:** Keep the internal-stabilisation goal. Ship v1.1.0 this week by the current deploy method so the S1 security fixes (BUG-002/003/005) and migrations 032–036 reach production; build OPS-05 next and prove the pipeline with v1.1.1. S3 bugs (BUG-006/008/004) in parallel. PRV-03 marked superseded by PRV-02.
- **Options considered:** A release first, pipeline next (chosen); B fix S3 bugs first, then release (S1 holes stay live longer); original plan — wait for OPS-05 and release v1.1.0 through it (S1 holes live 1–2 more weeks).
- **Why:** Three S1 holes are live on v1.0.0 and backups can only run from `main`; S3 bugs are lower risk. PRV-01 still first — owner commits to this week.
- **Revisit if:** the first CI run on dev → main finds significant failures, or migrations 032–036 fail on the live DB.

### 2026-10-23 — Deploy v1.1.0 by hand now; prove the pipeline with v1.1.0, then v1.1.1
- **Decision:** Strategy A — owner closes live risk this week: PRV-01 billing, manual deploy of v1.1.0 (+ migrations 032–036), first backup run + restore test. Next week: copy OPS-05 drafts, merge deployment PR #10 (redeploys v1.1.0 = low-risk pipeline test), then ship v1.1.1 (dev fixes + migrations 037–038) through the pipeline. Sensitive meetings are paused until PRV-01 is done.
- **Options considered:** A close live risk first (chosen); B finish OPS-05 first and jump prod from v1.0.0 to v1.1.1 (S1 holes stay live longer; 7 migrations at once).
- **Why:** As of 2026-10-23 the code is ahead of plan (v1.1.0 tagged, all S3 Now bugs fixed on dev) but prod is still v1.0.0 with three live S1 holes, meetings still use a free-tier key, and backups have never run. The two owner actions that close the worst risks take minutes; the pipeline can then be tested on an already-deployed version.
- **Revisit if:** the manual v1.1.0 deploy or migrations 032–036 fail, the pipeline test with v1.1.0 fails, or billing cost exceeds the budget.

### 2026-10-23 — No Gemini billing; current keys for all models
- **Decision:** PRV-01 parked. All models keep using the current keys regardless of tier; possible data use by AI providers is accepted. The pause on sensitive meetings is lifted. Supersedes the PRV-01 parts of the 2026-10-21 and 2026-10-23 entries.
- **Options considered:** A enable billing (no-train, paid per token); B stay on current keys (chosen).
- **Why:** owner priority is cost and simplicity for internal use; privacy is handled by the retention purge (PRV-02) and recording notice (COM-01), not by provider terms. Free-tier rate limits are absorbed by retry/backoff and the key pool.
- **Revisit if:** outside users or commercialisation, a customer/legal requirement, or free-tier rate limits make processing unreliable.

### 2026-10-23 — Agent queue while the owner does the ops steps
- **Decision:** Strategy A — agents first reduce the owner's manual work (OPS-07 runbook + verify script, PRF-08 drift, draft v1.1.1 release PR), then re-spec OPS-02 and build PRF-09. Goal and horizon unchanged; owner does deploy v1.1.0, backup and OPS-05 this week. Earlier agent queue (BUG-013/014/015/016/017, OPS-06) is done.
- **Options considered:** A owner support first (chosen); B features first (PRF-09, OPS-02 spec) — agents busy elsewhere during the week the owner needs ops support.
- **Why:** the owner's ops steps gate v1.1.1 and the S1 fixes on prod; a runbook + verify script make them faster and less error-prone, and a ready draft release PR shortens the last step.
- **Revisit if:** the owner's ops steps slip past next week, or the draft release PR needs repeated rebasing.

### 2026-10-25 — Re-platform to v2 (ARC); v1 frozen with a minimal safety net
- **Decision:** Strategy A — the goal becomes the v2 re-platform (ARC-00 → ARC-16: FastAPI + SPA from Figma Make, Neon Postgres, self-managed auth, full data migration, single cutover). v1 is frozen: no new features, no further v1 ops (v1.1.1 is released but will not be deployed; OPS-05 for v1 stopped). Kept as a safety net before ARC-03: fix the backup (the `backup` environment also accepts `dev`, the default branch), one restore test, apply code-independent migrations 034–038, close deployment PR #10. No fixed horizon; checkpoints C1/C2/C3. OPS-02 staging and the deploy pipeline move into ARC-15; PRF-09, PRO-04, PRO-05, CST-01 move after v2. Supersedes the 2026-10-21 goal and the 2026-10-22/23 deploy plans.
- **Options considered:** A ARC + safety net (chosen); B ARC only — no backup and possibly live S1 holes on prod until cutover. Backup fix: default branch → `main` (not chosen) vs `backup` environment accepts `dev` (chosen).
- **Why:** The owner wants CSR with separately built FE/BE and a new UI; building v1 features now would mean porting them twice. Status on 2026-10-25: deployment PR #13 was merged but the deployment repo has no ricotdin deploy workflow, so prod is still on an older v1 (version unknown); the DB backup has never succeeded. The safety net costs the owner under an hour and protects the data that ARC-03 migrates. Trade-off accepted: backup secrets become usable by workflows on `dev`, which is not reviewed before push.
- **Revisit if:** a v1 S1 bug needs app code on production, a migration rehearsal fails, or the stack choice (Neon / self-built auth) proves too costly in ARC-02 / ARC-05.
