# Meeting Assistant — Bug Log

> One row per bug. Managed by the `/fix-bug` skill (`.claude/skills/fix-bug/SKILL.md`).
> **Bug ID**: `BUG-NNN`, three digits, never reused.
> **Severity**: S1 = data loss / security / app unusable · S2 = core flow broken (record → process → results → chat), no workaround · S3 = broken with a workaround, or non-core · S4 = cosmetic.
> **Status**: `open` · `in_progress` · `fixed` · `wontfix` · `duplicate`.
> **Fix type**: `bugfix` (unreleased code, fixed on `dev`) · `hotfix` (affects a released `vX.Y.Z`, fixed on `release/X.Y`).
> **Found in**: version tag (e.g. `v1.0.0`) or `dev`. **Fixed in**: version that ships the fix, or `dev` until released.
> **Feature**: related feature code from `tracking.md`, or `—`. **Link**: branch, then `PR #N` once opened.
> Keep cells free of `|`. Details (repro, root cause) go in the matching `## BUG-NNN` section below the table.

| Bug ID | Title | Severity | Status | Found in | Feature | Fix type | Fixed in | Link |
|---|---|---|---|---|---|---|---|---|
| BUG-001 | docker-compose maps port 3333 but the image listens on 80 | S3 | fixed | v1.0.0 | OPS-04 | bugfix | dev | fix/BUG-001-compose-port |

---

## Details

<!-- Template — copy for each bug, newest at the bottom:

## BUG-NNN — <Title>

**Reported:** YYYY-MM-DD · **Severity:** S? · **Found in:** v?.?.? / dev · **Feature:** <CODE or —>

**Steps to reproduce**
1. ...

**Expected**
...

**Actual**
... (exact error / log line)

**Root cause**
...

**Fix**
<what changed, regression test name: tests/<file>.test.ts — "<test name>">

-->

## BUG-001 — docker-compose maps port 3333 but the image listens on 80

**Reported:** 2026-10-21 · **Severity:** S3 · **Found in:** v1.0.0 (also `dev`) · **Feature:** OPS-04

**Steps to reproduce**
1. `docker compose --env-file .env.local up --build -d`
2. Open http://localhost:3333 (as README says), then `docker compose ps`.

**Expected**
App answers on http://localhost:3333 and the container becomes `healthy`.

**Actual**
Connection reset / empty reply on :3333; container stays `unhealthy` (compose healthcheck `wget http://localhost:3333/` fails). Plain `docker run -p 3333:3333` from README fails the same way.

**Root cause**
Commit `e727faf` (2026-07-13) removed nginx from the image (nginx :80 → Next :3000) and made Next.js listen directly on `PORT=80` / `EXPOSE 80`. `docker-compose.yml` (`ports: "3333:3333"`, healthcheck on `localhost:3333`) and README (nginx on 3333, `-p 3333:3333`) were not updated, so the host port forwards to a container port nothing listens on. Production is unaffected (deployment repo maps its own port).

**Fix**
`docker-compose.yml`: `ports` → `"3333:80"`; removed the compose-level healthcheck so the image's `HEALTHCHECK` (`GET /api/health` on :80) applies. README: Docker section no longer mentions nginx; `docker run -p 3333:80`; port table fixed.

**No automated regression test** — the bug is pure container config (compose port mapping vs image `PORT`); there is no logic to extract into a pure function, and project tests must be I/O-free (§10). Manual repro instead (2026-10-21, Docker 29.5.2, image built from this branch):
- Before (`-p 3333:3333`): `curl localhost:3333/api/health` → empty reply (curl exit 52); in-container `:3333` connection refused, `:80` → `{"status":"ok"}`.
- After (fixed compose): container `healthy`, ports `0.0.0.0:3333->80/tcp`, `curl localhost:3333/api/health` → `{"status":"ok"}`, `/` → 200.

Follow-ups (not in this fix): delete dead `start.sh` + `nginx.conf` (pre-`e727faf` nginx setup); optionally pin `PORT: "80"` in compose `environment:` so a `PORT` in `.env.local` can't override it; Dockerfile comments still say secrets come from Kubernetes.
