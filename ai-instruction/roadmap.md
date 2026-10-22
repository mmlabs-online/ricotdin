# Ricotdin — Roadmap & Strategy

> Owned by the project owner. Maintained through the `/copilot plan` skill
> (`.claude/skills/copilot/SKILL.md`) — Claude proposes, the owner decides, and only
> approved changes are written here.
> Items reference feature codes from `tracking.md` (and `BUG-NNN` from `bugs.md`).
> New work that has no code yet goes through `/add-feature` first.

## North star

Ricotdin is a meeting assistant our own team trusts with sensitive meetings: every recording
is processed under no-training terms, audio is purged on a schedule, and every release reaches
the home server through one reviewed, health-checked, reversible merge.

## Current goal

| Field | Value |
|---|---|
| Goal | Stabilise for **internal use** with sensitive meetings — privacy first, then a reliable release/deploy path. No outside users. |
| Horizon | 1 month: 2026-10-21 → 2026-11-21 |
| Success measures | (1) No meeting is processed on a free-tier Gemini key. (2) Audio older than the retention setting is purged automatically. (3) v1.1.0 is in production this week (S1 fixes live); v1.1.x is then deployed via OPS-04/05 and the OPS-05 verification prompt prints `DEPLOYED v1.1.x`. (4) A DB restore has been tested once. |
| Constraints (people, time, budget) | All code by AI agents (`/fix-bug`, `/ship-feature`); owner approves and does dashboard/billing/Docker steps. Meetings contain **sensitive data**. **Low AI budget** — watch `/admin/usage` weekly; Speechmatics minutes are the main cost driver. |

## Now (in progress / next up)

| Item | Codes | Why now | Done when |
|---|---|---|---|
| 1. Enable Gemini billing (no-train) — owner, this week | PRV-01 | Sensitive meetings must not go to a free-tier key | Only billed-project keys active at `/admin/keys`; Speechmatics data-use terms confirmed |
| 2. Release v1.1.0 this week | — (§9k) | 3 S1 fixes (BUG-002/003/005) + PRV-02, COM-01, OPS-03 are only on `dev`; backups can't run until `main` | CI green on PR `dev → main`; migrations 032–036 applied + verify queries pass; tag `v1.1.0`; deployed (current method); `/version.json` = `v1.1.0` |
| 3. Start backups — owner, after item 2 | OPS-03 | Free tier has no backups | First green `db-backup` run from `main`; one test restore logged in `docs/ops/backup-restore.md`; tracking `[x]` |
| 4. Deployment-repo setup + verification | OPS-05 | Releases should deploy through one reviewed merge | Drafts written and copied to mmlabs-online/deployment (port `:3000`); verification prompt passes |
| 5. Release v1.1.1 through the new pipeline | — (§9k) | First real run of release.yml → deployment PR | `DEPLOYED v1.1.1` from the OPS-05 prompt |
| 6. Security S3 bugs (in parallel) | BUG-006, BUG-008, then BUG-004 | Remaining client-write / storage holes from the review round | Each fixed via `/fix-bug`, shipped in v1.1.x |

## Next

| Item | Codes | Depends on |
|---|---|---|
| Staging as a second compose project on the home server + second Supabase project (re-spec) | OPS-02 (re-spec via `/add-feature`) | OPS-05 |
| Point CLAUDE.md §9a at CHANGELOG's full migration checklist | needs `/fix-bug` (docs) | — |
| Confirm reverse proxy sets `x-forwarded-for` (login rate limit + audit IP rely on it) | — (check) | OPS-05 |
| Read-only DB role for backups | — (follow-up in `docs/ops/backup-restore.md`) | OPS-03 |
| CI on dev PRs (lint/typecheck/test) — today only PRs into `main` are checked | needs `/add-feature` (OPS) | — |

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
