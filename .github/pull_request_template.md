<!-- Title: [CODE] summary — e.g. [PRO-09] Shareable summary link, [BUG-004] Fix double charge on retry.
     Release PRs: chore(release): vX.Y.Z — list the codes below instead. See CLAUDE.md §9l. -->

## Tracking

- **Feature(s):** <!-- e.g. PRO-09 (ai-instruction/tracking.md) — or — -->
- **Bug(s):** <!-- e.g. BUG-004 (ai-instruction/bugs.md) — or — -->
- **Type:** <!-- feature | bugfix | hotfix | release | chore -->

## What changed

-

## How it was verified

<!-- Tick only what ran, per area touched (CLAUDE.md §0). -->
- [ ] v1: `cd legacy && npm run lint && npm run typecheck && npm run test && npm run build`
- [ ] v2 api: `cd app/api && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest -q`
- [ ] v2 web: `cd app/web && npm run typecheck && npm test && npm run build`
- [ ] Regression / new tests: <!-- legacy/tests/<file>.test.ts | app/api/tests/test_<topic>.py | app/web/src/**/<name>.test.ts -->
- [ ] Manual check: <!-- the feature's "Done check" or the bug's repro steps -->

## Deploy notes

- Migrations: <!-- none | legacy/migrations/0NN_x.sql (v1, apply BEFORE starting the new image) | app/api Alembic revision (v2) -->
- Env vars / dashboard steps: <!-- none | ... -->

## Tracking updated

- [ ] `tracking.md` row set to `[x]` and `PR #<n>` noted (features)
- [ ] `bugs.md` row set to `fixed` and `PR #<n>` noted (bugs)
- [ ] `CHANGELOG.md` entry with the code(s)
