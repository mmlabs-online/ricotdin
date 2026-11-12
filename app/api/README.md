# Ricotdin API (v2, FastAPI)

Core comes in ARC-04 (`ai-instruction/features/feature-Architecture-ARC.md`). The database schema
(ARC-02) is described in `CLAUDE.md` §0.1.

```bash
uv sync                                         # install (Python 3.12, from .python-version)
uv run uvicorn app.main:create_app --factory --reload   # http://localhost:8000/health

# checks (integration tests are skipped without DATABASE_URL)
uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest -q
uv run --env-file .env pytest -q                # incl. *_integration.py against the local container
```

## Database

`app/api/.env` (gitignored, one line): `DATABASE_URL=postgresql://postgres:dev@localhost:5432/postgres`,
a local superuser container with the production image (tests create scratch databases):
`docker run -d --name ricotdin-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 pgvector/pgvector:pg17-trixie`.
The deployed database (shared self-hosted Postgres, no published port) is handled on the Mac:
`docs/ops/self-hosted-postgres.md` (ARC-20).

```bash
uv run --env-file .env alembic upgrade head               # migrate the dev database
uv run --env-file .env python -m scripts.gen_baseline     # regenerate migrations/sql/0001_baseline.sql
```

Runtime logins (one per role, `CLAUDE.md` §0.2) — creates/rotates them and writes
`DATABASE_URL_APP` / `_SERVICE` / `_WORKER` into `.env`:

```bash
uv run --env-file .env python -m scripts.provision_db_roles
uv run --env-file .env uvicorn app.main:create_app --factory --reload   # refuses an over-privileged login
docker build -t ricotdin-api:local .
grep -E '^DATABASE_URL_' .env > runtime.env          # runtime-only: never the owner DATABASE_URL
docker run -p 8000:8000 --env-file runtime.env ricotdin-api:local
```

Never point `DATABASE_URL` at the `main` (production) branch: the integration tests create and drop
`ricotdin_test_*` databases there.
