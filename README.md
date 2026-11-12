# Ricotdin — Meeting Assistant

Record meetings in the browser → AI transcript + summary + notes + to-dos + a RAG chatbot over
your meetings, with timestamp citations.

**Stack (v2):** FastAPI (Python 3.12, uv) · Vite + React SPA · Neon Postgres + pgvector ·
Google Drive (audio and avatars) · Gemini / OpenAI-compatible providers · Speechmatics · Docker

## Layout

| Path | What |
|---|---|
| [`app/api/`](app/api/README.md) | Backend: REST API and the pipeline worker (one image) |
| [`app/web/`](app/web/README.md) | Frontend SPA |
| `ai-instruction/` | Feature tracking, bugs, roadmap, runtime pipeline prompt (`ai-gen/`) |
| `docs/architecture/` | Design rules per area (the `§0.x` sections cited in code) |
| `docs/ops/` | Owner runbooks: staging, migration, cutover, backup/restore |

The v1 app (Next.js + Supabase) was removed from `dev` in ARC-16. It is kept in git history and
on the `release/1.1` branch (tags ≤ v1.1.1).

## Development

```bash
cd app/api && uv sync && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest -q
cd app/web && npm ci && npm run typecheck && npm test && npm run build
```

Local setup (database, env files, Google Drive connection) is in `app/api/README.md` and
`app/web/README.md`. Working rules for contributors and coding agents: [`CLAUDE.md`](CLAUDE.md).

## Release and deploy

Tag `vX.Y.Z` on `release/X.Y` → `release.yml` builds `ricotdin-api` + `ricotdin-web` and opens the
deployment PR; merging it deploys. Staging: push `staging/X.Y.Z`. Details: `CLAUDE.md` §9k,
`docs/ops/staging.md`, `docs/ops/v2-cutover.md`.
