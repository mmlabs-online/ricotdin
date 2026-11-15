# ricotdin database on the shared self-hosted Postgres (ARC-20)

ricotdin has one environment, production, and one database: `ricotdin` on the shared Postgres that
the deployment repository (`mmlabs-online/deployment`, folder `postgres/`) runs on the Mac. v1
(Supabase), the v2 staging environment and Neon are retired (owner decision 2026-11-12). The
database started empty; no v1 or Neon data was carried over.

| | |
|---|---|
| Server | `pgvector/pgvector:pg17-trixie` (official `postgres:17` + pgvector), compose project `postgres` |
| Address | `postgres:5432` on the Docker network `db` (internal, no internet). **No published port** |
| Database / owner role | `ricotdin` / `ricotdin` (not a superuser: `CREATEROLE` only) |
| Owner password | deployment repo `postgres/secrets/apps/ricotdin.password` (hex, no URL escaping) |
| Superuser extras | deployment repo `postgres/sql/apps/ricotdin.sql`: extensions `vector` + `pgcrypto`, `CREATEROLE` |
| TLS | none (`sslmode=disable`): traffic stays on Docker's internal network |
| Backups | the `pg-backup` sidecar dumps it nightly; offsite sync + restore test in the deployment repo `ops/backup/` |

**One ricotdin database per server.** Roles are cluster-wide and ricotdin's role names are fixed
(`ricotdin_app`, `ricotdin_service`, `ricotdin_worker`, `ricotdin_*_login`). A second ricotdin
database on the same server would share them. A test copy belongs in a throwaway container
(`ops/backup/restore-test.sh ricotdin`) or a local one (below), never next to production.

## Why the owner is not a superuser, and what that changed

- `vector` is not a trusted extension, so the owner cannot create it. The superuser creates both
  extensions (`ricotdin.sql`). Migration `0001` then only runs `CREATE EXTENSION IF NOT EXISTS`, a no-op.
- `CREATEROLE` (PG16+) lets the owner manage only the roles it created itself. Migrations and
  `scripts.provision_db_roles` therefore never name `CREATEDB` / `BYPASSRLS` in `ALTER ROLE` unless the
  role actually has them: naming an attribute needs that attribute yourself.
- `CONNECT` is revoked from `PUBLIC` on every database of the shared server, so `provision_db_roles`
  grants `CONNECT` on the owner's database to each login. `drop_login` revokes it again.
- Integration test: `tests/test_db_provision_integration.py`, which uses a CREATEROLE-only owner on
  a database with no PUBLIC privileges.

## Migrations and runtime logins: done by the deploy

Nothing to run by hand. The deployment repo's `deploy-ricotdin-v2.yml` (step `database`), on every
deploy and before any container is replaced, runs on the Mac:
1. builds the owner URL from `postgres/secrets/apps/ricotdin.password`;
2. dumps the databases with the `pg-backup` sidecar;
3. runs `alembic upgrade head` with the release's API image on the `db` network;
4. **the first time only**, runs `python -m scripts.provision_db_roles`, which creates
   `ricotdin_api_login` / `_service_login` / `_worker_login` and writes their URLs
   (`postgres:5432`) to `~/.config/ricotdin/db-logins.env` (chmod 600, kept across deploys).

The `envfile` step then copies those URLs into `api.env` / `worker.env`. There are no
`DATABASE_URL` secrets. The owner URL never reaches an app env file: the app never runs as the
owner (RLS, `docs/architecture/db.md`). If a migration fails, nothing is replaced; restore from the
dump just taken if it left the schema half-applied.

**Rotate the runtime logins:** delete `~/.config/ricotdin/db-logins.env` on the Mac, then run
*Actions → deploy-ricotdin-v2 → Run workflow*. The deploy creates new passwords, and old sessions
are cut off.

**By hand** (for debugging), with the image from `apps/ricotdin-v2/release.env`:

```bash
IMG=mingming21400/ricotdin-api:<tag>@sha256:<digest>
OWNER="postgresql://ricotdin:$(cat ~/srv/postgres/secrets/apps/ricotdin.password)@postgres:5432/ricotdin?sslmode=disable"
```

```bash
docker run --rm --network db -e DATABASE_URL="$OWNER" "$IMG" alembic current
```

Shell access: `docker compose -p postgres -f ~/srv/postgres/compose.yml exec postgres psql -U postgres -d ricotdin`,
or pgAdmin (`pgadmin.mmlabs.online`).

## Local development and tests

The integration tests need a superuser (they create scratch databases), never the shared server:

```bash
docker run -d --name ricotdin-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 pgvector/pgvector:pg17-trixie
```

`app/api/.env`: `DATABASE_URL=postgresql://postgres:dev@localhost:5432/postgres`. CI uses the same
image (`ci-api.yml`).
