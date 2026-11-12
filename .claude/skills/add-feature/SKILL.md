---
name: add-feature
description: Turn a rough idea into a ship-ready tracked feature — interactive brainstorm (Q&A), 2–3 grounded options with a recommendation, converge on the most concrete smallest-valuable slice, pass a Definition of Ready, then add it to ai-instruction/tracking.md, ai-instruction/features/*.md and the `features` DB table. Use when the user has a new idea, wants to brainstorm a feature, or says "add this to the feature list". Does NOT implement anything — hand off to /ship-feature.
argument-hint: "<rough idea, any language>"
---

# Add a feature (idea → brainstorm → ship-ready feature)

Intake workflow for new ideas. The goal is not to record the idea as stated, but to
**brainstorm it with the user and converge on the most concrete version that one
`/ship-feature` run can deliver**. Output is a `[ ]` feature with a code (e.g. `PRO-09`).
This skill writes **docs only — no app code, no migrations**. `CLAUDE.md` always wins.

Input: `$ARGUMENTS` — the raw idea, in any language. Talk to the user in their language;
write the feature itself in English (feature files and `tracking.md` are English).

The brainstorm runs in the **main session** (only it can ask the user). Subagents are
advisory, called with the Agent tool; `subagent_type` is the agent's frontmatter `name`.

---

## Step 1 — Ground yourself (silent, before asking anything)

Do this quietly so your questions and options are specific to this repo:

1. **Duplicates:** Grep `ai-instruction/tracking.md` and `ai-instruction/features/*.md` for
   the idea's key nouns and synonyms.
   - Exists and done → tell the user the code; offer to brainstorm an *enhancement* of it instead.
   - Exists, not done → tell the user the code; offer to brainstorm/refine that spec instead.
   - Partial overlap → keep the related codes; they shape the options and dependencies.
2. **Scope:** compare with `CLAUDE.md` §1 "Explicitly OUT of MVP scope" and the hard rules
   in §5–§7 (all in `legacy/CLAUDE.md` since ARC-19; v2 rules in `docs/architecture/*.md`). Out-of-scope parts are not rejected — they become the "parked" option (Step 3)
   or go to the **PRO** module.
3. **Code reality:** Grep/Glob for what already exists that the idea could build on
   (tables, routes, components, `lib/` helpers). Note reusable pieces — they make an option
   cheaper. Use **Codebase Archaeologist** only for an unfamiliar area.

## Step 2 — Brainstorm Q&A (interactive)

Goal: understand **who**, **the pain**, and **what "good" looks like** well enough to
generate real options. Use AskUserQuestion with concrete, pre-filled choices
(the user can always pick "Other"); never ask open-ended essay questions.

- **Round 1 (always):** up to 3 questions from:
  - Who hits this — user, admin, or the system? How often?
  - What do they do today instead (workaround), and what's the cost of that?
  - What single outcome would make them say "done"?
  - Is there a hard constraint (deadline, provider, privacy, cost)?
- **Round 2 (only if needed):** up to 3 follow-ups that the answers opened up —
  edge cases, data they expect to see, where in the UI it belongs.
- **Max 2 rounds.** Don't ask anything you could answer from the code or from Step 1.
  After each round, play it back in one or two sentences ("So: admins need X because Y")
  so the user can correct you early.

## Step 3 — Diverge: options + recommendation

Produce **2–3 options** that solve the same problem at different sizes. Optionally ask
**Product Manager** (one call, give it Step 1 + Step 2 notes) for alternatives and
risks you missed; you make the final call.

For each option give:

| Field | Content |
|---|---|
| What the user gets | one sentence, user-visible |
| How (sketch) | reused pieces from Step 1 + what's new (route, table, component) |
| Size | ~files touched; needs migration / env var / new provider? (= structural) |
| Risks / unknowns | what could make it slip |
| Leaves out | what's deferred |

Typical shape: **A. Smallest valuable slice** · **B. Balanced** · **C. Full vision**
(often partly out of MVP scope → parked in PRO).

Then **recommend one**, with a 2–3 sentence reason. Default to the smallest option that
still removes the core pain, unless the user's constraints rule it out. Prefer options
that reuse existing code, avoid new migrations/providers, and fit one `/ship-feature` run.

Ask the user to pick (AskUserQuestion, recommended option first, labelled "(Recommended)").
They may mix options — that's fine; restate the merged result.

## Step 4 — Converge: make it ship-ready

Turn the chosen option into a concrete spec and check it against the
**Definition of Ready**. Every box must be true before Step 5:

- [ ] **One user-visible outcome.** If it's really two, split: the rest becomes a
      follow-up (Step 4.1).
- [ ] **3–6 acceptance criteria**, each testable and phrased "Given … when … then …" or as
      an observable check. No "should be fast/nice".
- [ ] **Test plan:** the pure function(s) to extract into `/lib` and the test file name
      (`tests/<topic>.test.ts` for v1 in `legacy/`; v2: `app/api/tests/test_<topic>.py` or
      `app/web/src/**/<name>.test.ts` — CLAUDE.md §0) — this is what `/ship-feature` Phase 3 writes first.
- [ ] **Touch list:** expected files/routes/components, from the Step 1 code scan.
- [ ] **Structural flags called out:** new migration, env var, provider, auth/RLS change,
      or >~10 files. Allowed, but stated, so `/ship-feature` knows to stop for plan approval.
- [ ] **Dependencies** are existing codes; anything not done is listed explicitly.
- [ ] **No open questions.** Anything unresolved is either decided now (ask) or moved to
      "Out of scope".
- [ ] **Done check:** the one command/manual check that proves it works.

If a box can't be ticked, go back one step (usually: shrink the option, or ask one more
question). Don't paper over it.

### 4.1 Follow-ups

What was cut (Option B/C extras, split-off outcomes) is listed for the user. Ask whether
to record each as its own `[ ]` feature now (each goes through Steps 5–8 with a short spec)
or just mention it under "Out of scope". Don't create them silently.

## Step 5 — Classify

1. **Module.** Best-fitting existing prefix (list in the `tracking.md` header). Create a new
   module only with the user's confirmation. Out-of-MVP-scope → **PRO**.
2. **Code.** Highest existing `PREFIX-NN` across `tracking.md` **and** the module file, + 1,
   two digits (`PRO-08` → `PRO-09`). Never reuse a number.
3. **Note tags / priority.** *Blocker* / *Mandatory* / *SaaS* as defined in `tracking.md`;
   priority High / Medium / Low, from the brainstorm (frequency × pain). **Sprint Prioritizer**
   may rank it against open `[ ]` features if the user asks how important it is.

## Step 6 — Draft and get approval

Show both drafts in full and **wait for an explicit yes or edits**. Nothing is written before.

**A. `tracking.md` row** — 8 columns, single line, no `|` inside cells:

```
| <Module name> | <Feature short name> | <CODE> | As a <role>, I want <capability> so that <outcome>. | <What the system does, 1–2 sentences.> | `[ ]` | <DEP-01, DEP-02 or —> | <Tags.> Priority: <High|Medium|Low>. <Short note> |
```

The parser reads `Priority: High` and the words Blocker / Mandatory / SaaS from the last
column — keep that exact spelling.

**B. Feature section** for `ai-instruction/features/feature-<Name>-<PREFIX>.md`:

```
### <CODE> — <Title>
**Priority:** <High|Medium|Low> | **Status:** ❌ Not started

**User Story**  
As a <role>, I want <capability> so that <outcome>.

**Context**
<The pain + current workaround from the brainstorm, 2–3 sentences. Chosen option and why;
rejected options in one line each.>

**Use Cases**
1. ...

**Frontend**
- ...

**Backend**
- ...

**Acceptance Criteria**
- Given ..., when ..., then ...

**Test Plan**
- Pure logic: `lib/<area>/<file>.ts` → `<fnName>()` ...
- Tests: `tests/<topic>.test.ts` — <cases>

**Structural flags**
- <migration / env var / provider / RLS — or "none">

**Done check**
- <command or manual check>

**Out of scope**
- <deferred items / follow-ups>

**Key files (expected)**
- `path/...`

---
```

Format rules (the seeder depends on them):
- Heading exactly `### <CODE> — <Title>` (em dash).
- `**User Story**` followed by the story on the next line, then a blank line.
- `**Status:** ❌ Not started` for every new feature.

## Step 7 — Write the files

1. **`tracking.md`:** insert the row directly after the last row of the same module
   (keep modules grouped). New module → also add its prefix to the "Module prefixes" header.
2. **Feature file:** insert the section at the end of `## Features`, i.e. before
   `## Data Flow` / `## Dependencies` if present, otherwise at the end of the file.
   New module → create `feature-<Name>-<PREFIX>.md` with an H1 `# <Name> Module (<PREFIX>)`,
   `**Module prefix:**`, `**Status:**`, `**Key files:**`, `## Overview`, `## Features`.
3. If the module file has a `## Dependencies` section, update its **Blocks:** /
   **Depends on:** lines as appropriate.

## Step 8 — Sync the DB registry

```
cd legacy && npx tsx scripts/seed-features.ts --only <CODE>[,<CODE>]
```

- **Never run the seeder without `--only`** — a full run overwrites every edit made at
  `/admin/features`.
- `No "### <KEY> — <Title>" section found` → the heading format is wrong; fix Step 7.
- Missing `.env.local` / Supabase credentials → skip, and give the user the command.

## Step 9 — Commit

On `dev` (or a `docs/<code>-<slug>` branch from `dev`; never `main` / `release/*`), commit
only the `ai-instruction/` changes:

```
docs(features): add <CODE> <title>
```

Do not push without asking.

## Final report

- Code + title, module, priority, dependencies, structural flags.
- One line on the brainstorm: the options considered, which was chosen, and why.
- Follow-ups recorded (codes) or deferred.
- Files changed, DB sync result (or the command for the user to run).
- Next step: `/ship-feature <CODE>` — or, for PRO features, a reminder that they need an
  explicit go decision before building.
