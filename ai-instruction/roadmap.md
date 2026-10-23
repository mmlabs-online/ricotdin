# Ricotdin — Roadmap & Strategy

> Owned by the project owner. Maintained through the `/copilot plan` skill
> (`.claude/skills/copilot/SKILL.md`) — Claude proposes, the owner decides, and only
> approved changes are written here.
> Items reference feature codes from `tracking.md` (and `BUG-NNN` from `bugs.md`).
> New work that has no code yet goes through `/add-feature` first.

## North star

Ricotdin is a meeting assistant our own team trusts with sensitive meetings: audio is purged
on a schedule, and every release reaches the home server through one reviewed, health-checked,
reversible merge.

## Current goal

| Field | Value |
|---|---|
| Goal | Stabilise for **internal use** with sensitive meetings — retention purge + recording notice, then a reliable release/deploy path. No outside users. |
| Horizon | 1 month: 2026-10-21 → 2026-11-21 |
| Success measures | (1) Audio older than the retention setting is purged automatically. (2) v1.1.0 is in production this week by the current method (S1 fixes live); the pipeline is then proven by redeploying v1.1.0 and shipping v1.1.1, and the OPS-05 verification prompt prints `DEPLOYED v1.1.1`. (3) A DB restore has been tested once. |
| Constraints (people, time, budget) | All code by AI agents (`/fix-bug`, `/ship-feature`); owner approves and does dashboard/Docker steps. Meetings contain **sensitive data**. **Current (free-tier) AI keys accepted for all models; provider data use accepted (owner, 2026-10-23).** **Low AI budget** — watch `/admin/usage` weekly; Speechmatics minutes are the main cost driver. |

## Now (in progress / next up)

| Item | Codes | Why now | Done when |
|---|---|---|---|
| 1. Deploy v1.1.0 to production — owner, this week (current method) | — (§9k) | Released 2026-10-22 but prod is still v1.0.0: S1 holes BUG-002/003/005 are live | Migrations 032–036 applied + verify queries pass; `/version.json` = `v1.1.0` |
| 2. First backup + restore test — owner, this week | OPS-03 | Secrets are set but `db-backup` has never run | `gh workflow run backup.yml --ref main` green; one restore logged in `docs/ops/backup-restore.md`; tracking `[x]` |
| 3. Prove the deploy pipeline with v1.1.0 — owner, next week | OPS-05 | Server env + cloudflared done; drafts not yet in the deployment repo | Drafts copied to mmlabs-online/deployment; deployment PR #10 merged; verification prompt prints `DEPLOYED v1.1.0` |
| 4. Release v1.1.1 through the pipeline | — (§9k) | BUG-004/006/008/011/012 + migrations 037–038 are on `dev` only | PR `dev → main`, `main → release/1.1`, tag `v1.1.1`; `DEPLOYED v1.1.1` |
| 5. Agent work in parallel | BUG-013; docs drift; CI on dev PRs | Keep the agents busy on low-risk items while the owner does 1–3 | BUG-013 fixed via `/fix-bug`; CHANGELOG known issues + CLAUDE.md §9a/§11 + PRV-03 tracking corrected; CI runs on PRs into `dev` (via `/add-feature` then `/ship-feature`) |

## Next

| Item | Codes | Depends on |
|---|---|---|
| Staging as a second compose project on the home server + second Supabase project (re-spec) | OPS-02 (re-spec via `/add-feature`) | OPS-05 |
| Confirm reverse proxy sets `x-forwarded-for` (login rate limit + audit IP rely on it) | — (check) | OPS-05 |
| Read-only DB role for backups | — (follow-up in `docs/ops/backup-restore.md`) | OPS-03 |

## Later

| Item | Codes | Note |
|---|---|---|
| Experience features | PRO-04, PRO-05 | After the stabilisation month |
| Cost model | CST-01 | Once a month of billed usage exists in `/admin/usage` |

## Not doing (explicitly parked)

| Item | Reason | Revisit when |
|---|---|---|
| Commercialisation (COM-02, COM-03, COM-04), ADM-11, PRF-13 self-service | Internal use only; SaaS scope | Goal changes to opening up (Group A) or commercialising (Group B) |
| PRV-03 (superseded) | Purge delivered by PRV-02 (2026-10-21); audio encryption not needed while purge is on | Audio must be kept long-term |
| PRV-01 Enable Gemini billing (no-train) | Owner decision 2026-10-23: stay on current keys for all models; AI-provider data use accepted for internal use | Outside users, commercialisation (Group A/B), or a customer/legal requirement |
| CST-02 as a separate item | Storage already on R2; purge covers the storage risk | Legacy Supabase bucket needs retiring |
| PRO-02 Google Calendar sync, PRO-03 reminders | Out of MVP scope (CLAUDE.md §1) | Explicit owner go decision |
| WebM remux, 39 lint warnings, in-memory login rate limit | Low impact for internal single-process use | Users complain / multi-instance deploy |

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
