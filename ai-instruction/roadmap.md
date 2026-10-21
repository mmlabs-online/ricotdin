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
| Success measures | (1) No meeting is processed on a free-tier Gemini key. (2) Audio older than the retention setting is purged automatically. (3) v1.1.0 is deployed via OPS-04/05 and the OPS-05 verification prompt prints `DEPLOYED v1.1.0`. (4) A DB restore has been tested once. |
| Constraints (people, time, budget) | All code by AI agents (`/fix-bug`, `/ship-feature`); owner approves and does dashboard/billing/Docker steps. Meetings contain **sensitive data**. **Low AI budget** — watch `/admin/usage` weekly; Speechmatics minutes are the main cost driver. |

## Now (in progress / next up)

| Item | Codes | Why now | Done when |
|---|---|---|---|
| 1. Fix compose port (3333 vs image :80) | needs `/fix-bug` | Breaks the OPS-04 Docker done-check for the wrong reason | `docker compose up` is healthy on :80 / `/api/health` |
| 2. Enable Gemini billing (no-train) — owner | PRV-01 | Embeddings + analysis + chat all go to Gemini; free tier may train on sensitive data | Only billed-project keys are active at `/admin/keys`; Speechmatics data-use terms confirmed |
| 3. Close OPS-04 — owner, Docker machine | OPS-04 | Release path; held by owner | actionlint clean + Docker done-check passed; tracking `[x]` |
| 4. Retention purge (minimal PRV-02, absorbs PRV-03 as purge) | PRV-02, PRV-03 | Sensitive audio should not accumulate | Daily job deletes audio past `storage.audio_retention_days`, nulls `audio_path`, audit-logged; player shows "Audio deleted"; one-page internal policy |
| 5. Recording notice (internal) | COM-01 | Cheap; a legal requirement in some places even internally | Notice shown and acknowledged before recording starts |
| 6. Deployment-repo setup + verification | OPS-05 | Merging a release PR must actually deploy | Drafts copied to mmlabs-online/deployment; verification prompt passes |
| 7. DB backup, re-scoped to the Supabase tier | OPS-03 (re-spec via `/add-feature`) | First real sensitive data needs a recovery path | Backups running (Pro: built-in; Free: encrypted `pg_dump` → R2) and one restore tested |
| 8. Release v1.1.0 via the new pipeline | — (§9k) | Month-end milestone; first run of the new release.yml | `DEPLOYED v1.1.0` from the OPS-05 prompt |

## Next

| Item | Codes | Depends on |
|---|---|---|
| Staging as a second compose project on the home server + second Supabase project (re-spec) | OPS-02 (re-spec via `/add-feature`) | OPS-05 |
| Point CLAUDE.md §9a at CHANGELOG's full migration checklist | needs `/fix-bug` (docs) | — |
| Confirm reverse proxy sets `x-forwarded-for` (login rate limit + audit IP rely on it) | — (check) | OPS-05 |

## Later

| Item | Codes | Note |
|---|---|---|
| Experience features | PRO-04, PRO-05 | After the stabilisation month |
| Cost model | CST-01 | Once a month of billed usage exists in `/admin/usage` |

## Not doing (explicitly parked)

| Item | Reason | Revisit when |
|---|---|---|
| Commercialisation (COM-02, COM-03, COM-04), ADM-11, PRF-13 self-service | Internal use only; SaaS scope | Goal changes to opening up (Group A) or commercialising (Group B) |
| PRV-03 audio encryption option | Purge gives a stronger guarantee for less work | Audio must be kept long-term |
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
