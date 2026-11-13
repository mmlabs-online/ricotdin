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

## Running migrations and provisioning logins

Postgres has no published port, so run these **on the Mac**, in a container on the `db` network,
with the API image of the release you are about to deploy (its tag + digest are in the release's
deployment PR, `apps/ricotdin-v2/release.env`):

```bash
IMG=mingming21400/ricotdin-api:<tag>@sha256:<digest>
OWNER="postgresql://ricotdin:$(cat ~/srv/postgres/secrets/apps/ricotdin.password)@postgres:5432/ricotdin?sslmode=disable"
```

Migrations, before every deployment PR is merged:

```bash
docker run --rm --network db -e DATABASE_URL="$OWNER" "$IMG" alembic upgrade head
```

The first time, and to rotate the passwords, write the three runtime logins to a 0600 file:

```bash
install -d -m 700 ~/.config/ricotdin && touch ~/.config/ricotdin/db.env && chmod 600 ~/.config/ricotdin/db.env
```

```bash
docker run --rm --network db --user "$(id -u)" -e DATABASE_URL="$OWNER" \
  -v ~/.config/ricotdin:/out "$IMG" python -m scripts.provision_db_roles --env-file /out/db.env
```

The env files are written by the deploy from deployment-repo secrets, never by hand. Set the
three URLs from `db.env` as secrets, then delete `db.env`:

```bash
gh secret set RICOTDIN_DATABASE_URL_APP -R mmlabs-online/deployment
```

```bash
gh secret set RICOTDIN_DATABASE_URL_SERVICE -R mmlabs-online/deployment
```

```bash
gh secret set RICOTDIN_DATABASE_URL_WORKER -R mmlabs-online/deployment
```

```bash
rm ~/.config/ricotdin/db.env
```

The URLs point at `postgres:5432`, which works because api and worker join the `db` network
(deployment repo `apps/ricotdin-v2/compose.yml`). The owner URL never goes into a secret or an app
env file. Re-running `provision_db_roles` rotates all three: set the three secrets again at once
and re-run *Actions → deploy-ricotdin-v2 → Run workflow*, or the app loses its database.

Shell access: `docker compose -p postgres -f ~/srv/postgres/compose.yml exec postgres psql -U postgres -d ricotdin`,
or pgAdmin (`pgadmin.mmlabs.online`).

## Local development and tests

The integration tests need a superuser (they create scratch databases), never the shared server:

```bash
docker run -d --name ricotdin-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 pgvector/pgvector:pg17-trixie
```

`app/api/.env`: `DATABASE_URL=postgresql://postgres:dev@localhost:5432/postgres`. CI uses the same
image (`ci-api.yml`).
