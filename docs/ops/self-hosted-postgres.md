# v2 database on the shared self-hosted Postgres (ARC-20)

ricotdin v2 no longer uses Neon. Its database is `ricotdin` on the shared Postgres that the
deployment repository (`mmlabs-online/deployment`, folder `postgres/`) runs on the Mac:

| | |
|---|---|
| Server | `pgvector/pgvector:pg17-trixie` (official `postgres:17` + pgvector), compose project `postgres` |
| Address | `postgres:5432` on the Docker network `db` (internal, no internet). **No published port** |
| Database / owner role | `ricotdin` / `ricotdin` (not a superuser: `CREATEROLE` only) |
| Owner password | deployment repo `postgres/secrets/apps/ricotdin.password` (hex, no URL escaping) |
| Superuser extras | deployment repo `postgres/sql/apps/ricotdin.sql`: extensions `vector` + `pgcrypto`, `CREATEROLE` |
| TLS | none (`sslmode=disable`): traffic stays on Docker's internal network |
| Backups | the `pg-backup` sidecar dumps it nightly, synced offsite (deployment repo `ops/backup/`) |

**One database, one environment at a time.** Roles are cluster-wide, and ricotdin's role names are
fixed (`ricotdin_app`, `ricotdin_service`, `ricotdin_worker`, `ricotdin_*_login`). A second ricotdin
database on the same server would share them, so a staging login could open production.
Until the role names are configurable (follow-up), `ricotdin` serves **v2 staging now** and becomes
**production at cutover** (ARC-15): the final migration reloads it, and staging stops or goes back
to Neon.

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
using the API image that will be deployed:

```bash
IMG=mingming21400/ricotdin-api:<tag>@sha256:<digest>      # from apps/ricotdin-v2-staging/release.env
OWNER="postgresql://ricotdin:$(cat ~/srv/postgres/secrets/apps/ricotdin.password)@postgres:5432/ricotdin?sslmode=disable"
```

```bash
docker run --rm --network db -e DATABASE_URL="$OWNER" "$IMG" alembic upgrade head
```

The first time, and to rotate the passwords, write the three runtime logins to a 0600 file:

```bash
install -d -m 700 ~/.config/ricotdin-staging && touch ~/.config/ricotdin-staging/db.env && chmod 600 ~/.config/ricotdin-staging/db.env
```

```bash
docker run --rm --network db --user "$(id -u)" -e DATABASE_URL="$OWNER" \
  -v ~/.config/ricotdin-staging:/out "$IMG" python -m scripts.provision_db_roles --env-file /out/db.env
```

Staging's env files are written by the deploy from deployment-repo secrets (OPS-02), never by hand.
Set the three URLs from `db.env`, then delete `db.env` and re-run the deploy:

```bash
gh secret set RICOTDIN_DATABASE_URL_APP -R mmlabs-online/deployment
```

```bash
gh secret set RICOTDIN_DATABASE_URL_SERVICE -R mmlabs-online/deployment
```

```bash
gh secret set RICOTDIN_DATABASE_URL_WORKER -R mmlabs-online/deployment
```

Then run *Actions → deploy-ricotdin-v2-staging → Run workflow*. The URLs point at `postgres:5432`,
which works because api and worker join the `db` network (deployment repo,
`apps/ricotdin-v2-staging/compose.yml`). The owner URL never goes into a secret or an app env file.
Re-running `provision_db_roles` rotates all three: set the three secrets again at once, or staging stops.

Shell access: `docker compose -p postgres -f ~/srv/postgres/compose.yml exec postgres psql -U postgres -d ricotdin`,
or pgAdmin (`pgadmin.mmlabs.online`).

## Moving the data off Neon (one time)

Only needed if the Neon data matters: staging can also start empty (`alembic upgrade head`, then
`migrate_from_supabase`). Neon runs Postgres 18, this server 17. The steps below were rehearsed with
a pg_dump 18 of a database migrated to head on PG 18: after the restore, the schema and ACLs were
identical to a fresh `alembic upgrade head` on 17. The only difference was this server's own
`REVOKE … ON SCHEMA public FROM PUBLIC`. `alembic current` showed head, and the data could be read
through the runtime logins.

The target `ricotdin` must be **empty** (freshly created by deploy-postgres, nothing migrated yet).
For a re-run, the superuser drops and recreates it, then re-runs `add-app-db.sh ricotdin`.

1. Dump Neon with pg_dump 18. `NEON_URL` is the owner's **direct** (not `-pooler`) URL, `sslmode=require`:
   ```bash
   docker run --rm -v "$PWD:/out" pgvector/pgvector:pg18-trixie pg_dump --format=custom --no-owner -d "$NEON_URL" -f /out/neon.dump
   ```
2. Stop the ricotdin v2 api + worker (`docker compose -p ricotdin-v2-staging stop api worker`).
3. On the Mac, restore as the owner. This creates the three group roles first, so the dump's GRANTs
   and policies apply. It skips the extensions (the superuser already made them) and the default
   privileges (they name Neon's owner role), and then re-applies the epilogue's default privilege
   as `ricotdin`:
   ```bash
   docker run --rm --network db -v "$PWD:/in" pgvector/pgvector:pg17-trixie sh -ec '
     psql -v ON_ERROR_STOP=1 -q "$0" -c "CREATE ROLE ricotdin_app NOLOGIN; CREATE ROLE ricotdin_service NOLOGIN; CREATE ROLE ricotdin_worker NOLOGIN;"
     pg_restore --list /in/neon.dump | grep -vE " (EXTENSION -|COMMENT - EXTENSION|DEFAULT ACL) " > /tmp/l
     pg_restore --exit-on-error --no-owner --use-list=/tmp/l -d "$0" /in/neon.dump
     psql -v ON_ERROR_STOP=1 -q "$0" -c "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC"' "$OWNER"
   ```
4. `alembic upgrade head` (above) must report nothing to do. Provision the logins (above), set the three
   `RICOTDIN_DATABASE_URL_*` secrets, re-run the staging deploy, then check `/health` and that a login works.
5. After a stable period, delete the Neon project. That is irreversible, so the owner confirms it.
   Also remove the `NEON_BACKUP_DATABASE_URL` secret and `backup.yml` (the sidecar backs up `ricotdin` now).

## Local development and tests

The integration tests need a superuser (they create scratch databases), never the shared server:

```bash
docker run -d --name ricotdin-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 pgvector/pgvector:pg17-trixie
```

`app/api/.env`: `DATABASE_URL=postgresql://postgres:dev@localhost:5432/postgres`. CI uses the same
image (`ci-api.yml`).
