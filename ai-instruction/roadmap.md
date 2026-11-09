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
| Goal | **Finish the backlog on v2, then rehearse and test, then fix the bugs found, then cut over (ARC-15).** Owner decision 2026-11-09. Three phases. **Phase 1 – build:** every open ticket that has its own UI and its own API, plus the small pre-go-live items. **Phase 2 – dry-run + test:** the migration rehearsal, production prep, and the staging rehearsal of `docs/ops/v2-cutover.md`. **Phase 3 – bugs:** the owner reports findings, each becomes a `BUG-NNN` via `/fix-bug`; then the cutover window. v1 stays frozen (hotfixes only on `release/1.1`). |
| Horizon | No fixed date. *Inference:* about 25–35 `/ship-feature` runs in phase 1. At the ARC pace (2–3 PRs a day), that is 2–3 weeks of agent work; the real limit is the owner's spec Q&A (`/add-feature`) and PR reviews. Phases 2–3 take five owner sessions plus the bug rounds. |
| Success measures | (1) Every phase-1 code is `[x]` in `tracking.md`, with an API test + a web test and EN/VI strings. (2) Two migration PASS reports with the Drive copy: rehearsal 1 + the staging rehearsal. (3) Staging rehearsal incl. a timed rollback. (4) No open S1/S2 bug at the cutover. (5) v2.0.0 live: the production smoke checklist passes; the first nightly Neon backup is uploaded. |
| Constraints (people, time, budget) | All code by AI agents; the owner specs (Q&A), reviews and does the dashboard/server steps, a few sessions a week. Meetings contain **sensitive data**. Current AI keys for all models (2026-10-23). **Low AI budget.** Production stays on its current v1 until the cutover. Supabase has no automated backup (`backup.yml` dumps Neon since ARC-15 part 2): it is covered by manual encrypted dumps. |

## Now (in progress / next up)

| Item | Codes | Why now | Done when |
|---|---|---|---|
| 1. Owner, now: encrypted manual Supabase dump (`pg_dump -Fc` + `age`, kept offline) + rotate the leaked keys (Supabase service_role/anon, Gemini `AQ.A…`), then update v1 prod env + `/admin/keys` with the new ones. Owner checklist: GitHub issue #71 (#72, #73, #74) | ARC-15 prep step 1, CLAUDE.md §0.11 | Independent of testing; data has no backup and the leaked keys still work | Dump stored; old keys rejected; v1 prod still works |
| 2. Agent: block bidi / zero-width characters in folder + meeting names in the API | needs `/add-feature` | Pre-go-live (owner 2026-11-09); small, unblocks nothing else | API 4xx on such names, tests green |
| 3. Agent: implement the three decisions of 2026-11-09 (issue #75): set-password link instead of 409 for an unverified email, 90-day absolute refresh lifetime, no chat refund for provider refusals | needs `/add-feature` (one code with the bidi check) | Pre-go-live; PRF-11 builds on the refresh lifetime | Each behaviour tested; CLAUDE.md §0.3/§0.8 "Open" lines replaced |
| 4. Agent: content tools — tags, transcript edit, PDF/MD export | PRO-06 | Unblocks PRF-07 | PRO-06 `[x]` |
| 5. Agent: default folder | PRF-07 | Needs PRO-06 | PRF-07 `[x]` |

## Next (phase 1, in this order unless a spec changes it)

| Item | Codes | Depends on |
|---|---|---|
| Per-user UI language; own activity feed; library search | PRF-06, PRF-09, PRO-05 | — |
| Active sessions + remote sign-out; then 2FA (TOTP) | PRF-11, PRF-12 | Now 3 (refresh lifetime) |
| Speaker naming / personalised diarization | PRO-04 | — |
| Admin data retention + user export / full erase (built together) | ADM-11, PRF-13 | — |
| Auto-email results; proactive reminders; notification settings | PRO-01, PRO-03, PRF-10 | PRO-03 + PRF-10 after PRO-01; **PRO-03 lifts the CLAUDE.md §1 exclusion (owner 2026-11-09): update §1 in that PR** |
| Cost model by usage (admin); then subscription plans + per-plan quota | CST-01, COM-03 | COM-03 after CST-01; COM-03 spec must name the payment provider and stays internal-test only until COM-02 legal docs exist |

## Later

| Item | Codes | Note |
|---|---|---|
| **Phase 2 – dry-run + test (owner sessions):** ② migration rehearsal 1 with Drive (C1) + wallet drift count; ③ production prep (cutover prep 3–8); RC `v2.0.0-rc1` (agent); ④ staging rehearsal = migration PASS #2 + timed rollback (C4) + manual test of every phase-1 feature | ARC-03, ARC-18, ARC-15 | After phase 1; a fresh manual Supabase dump before each rehearsal |
| **Phase 3 – bugs:** owner reports, `/fix-bug` per finding (S1/S2 before go-live); ⑤ cutover window | `BUG-NNN`, ARC-15 | After phase 2 |
| Drive orphan sweeper, ffmpeg sandbox | needs `/add-feature` | After go-live (owner 2026-11-09) |
| `storage.audio_retention_days` | — | After the final migration's file copy |
| Remove legacy + Supabase + v1 R2 buckets | ARC-16 | Irreversible — owner confirms |
| Small v2 follow-ups: `KEY_ENCRYPTION_SECRET` rotation, `--border-strong` contrast, `/process` on a `done` meeting, CI Node = image Node | `/add-feature` / `/fix-bug` | Low risk, internal use |

## Not doing (explicitly parked)

| Item | Reason | Revisit when |
|---|---|---|
| PRO-02 Google Calendar sync | Out of MVP scope (CLAUDE.md §1); not chosen 2026-11-09 | Explicit owner go decision |
| PRO-07 native app (Tauri), PRO-08 AI quality, COM-04 tenant isolation | No UI + API of their own (owner rule 2026-11-09); PRO-07 is a project of its own | After v2 is live |
| COM-02 legal docs | Not code (needs a lawyer) | Before outside users or real payments |
| BUG-021 hotfix on v1 | v2's `wallet_reconcile` sets wallets to the ledger sum; drift counted in rehearsal 1 | Drift count is large |
| Automated Supabase backup job | Manual encrypted dumps instead (owner 2026-11-09) | Cutover slips past January 2027 |
| Dependabot | Owner decision 2026-11-09 | — |
| Skipping the staging rehearsal | ARC-15 acceptance criterion | — |
| New v1 features / v1 ops | v1 frozen (2026-10-25) | An S1 bug needs app code on prod |
| PRV-01 Gemini billing | Owner decision 2026-10-23 | Outside users, commercialisation, legal requirement |
| PRV-03, CST-02 | Superseded (PRV-02 purge; storage is Drive, ARC-17) — close both | — |
| WebM remux, 39 v1 lint warnings | Low impact | Users complain |

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

### 2026-11-09 — Build the whole UI + API backlog on v2 first, then rehearse and test, then fix bugs, then cut over
- **Decision:** The owner wants every remaining ticket built before any dry-run. Rule for "every ticket": each open code that has its own UI and its own API — PRF-06, PRF-07, PRF-09, PRF-10, PRF-11, PRF-12, PRF-13, ADM-11, PRO-01, PRO-03, PRO-04, PRO-05, PRO-06, CST-01, COM-03 — plus the pre-go-live items (API bidi check, the three open decisions). Then phase 2: rehearsals and tests (strategy B of the cutover plan: migration rehearsal 2 runs inside the staging rehearsal). Then phase 3: the owner reports bugs, each fixed through `/fix-bug`, then the cutover. Owner opts into PRO-03 reminders + PRF-10 (lifts the CLAUDE.md §1 exclusion for reminders) and COM-03 subscriptions (was parked as SaaS scope). PRO-02, PRO-07, PRO-08, COM-04 and COM-02 stay out. Exception taken now, not in phase 2: an encrypted manual Supabase dump + rotation of the keys leaked in git history. Drive orphan sweeper and ffmpeg sandbox after go-live. Supersedes the 2026-10-25 "after v2" placement of PRF-09/PRO-04/PRO-05/CST-01/PRF-06/PRF-11/PRF-12 and the COM-03/ADM-11/PRF-13 "Not doing" rows.
- **Options considered:** test-first plan B (rehearse now, build after go-live) — the copilot's recommendation, not chosen; build everything incl. calendar OAuth, Tauri and multi-tenant (weeks more, out of scope); build only the small in-scope items first.
- **Why:** The owner prefers one full test pass over a complete product rather than testing twice. Risks accepted: migration problems with real v1 data surface later; every new Alembic migration widens the gap the migration script must cover (`V2_ONLY_TABLES` test, BUG-020, keeps that safe); v1 stays in production longer. COM-03 brings payments — its spec must name the provider and it stays internal-test only until COM-02.
- **Revisit if:** phase 1 runs past ~4 weeks, a spec turns out much larger than one or two `/ship-feature` runs, the leaked-key rotation is not done, or v2 opens to outside users.

### 2026-11-09 — The three open pre-go-live decisions (issue #75)
- **Decision:** (a) **Pre-registration (§0.3):** registering an email that belongs to an unverified account no longer answers 409; the API mails that address a set-password link and answers exactly as for a new registration (no enumeration). Setting the password through the link verifies the account and discards the pre-registered password. (b) **Refresh lifetime (§0.3):** absolute lifetime of **90 days** per session family, measured from sign-in, on top of the sliding 30 days; PRF-11 and PRF-12 build on it. (c) **Chat refunds (§0.8):** refund only failures on our side (provider transient error / timeout / no usable key / retrieval error, cancel); a provider refusal of the question itself (`AIRejected`: safety, 400/404/413/422) is charged.
- **Options considered:** (a) set-password link (chosen) / replace the unverified account after 24 h / keep 409. (b) 90 days (chosen) / 30 days / no absolute limit. (c) refund our failures only (chosen) / refund all with a daily cap / keep as is.
- **Why:** Sensitive meetings: an attacker must never own an account under someone else's address, and a stolen refresh cookie must not live forever. Refusals are the only failures a user can trigger on purpose, so they are the ones that stop being refunded.
- **Revisit if:** users complain about signing in every 90 days, or legitimate questions are often refused by a provider.
