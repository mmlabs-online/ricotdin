# Release runbook (OPS-07)

One ordered list for getting a release onto the home server and proving it runs.
It links to the detailed docs instead of copying them:

- **Per-release deploy checklist** (migrations, new env vars, dashboard steps): `CHANGELOG.md`, section
  `## [X.Y.Z]` → `### Checklist deploy`.
- **Backup & restore**: `docs/ops/backup-restore.md` (OPS-03).
- **Deployment-repo pipeline**: `docs/ops/deployment-repo/README.md` (OPS-05).
- **Release process (branches, tags)**: `CLAUDE.md` §9k.

Every step ends with a **Verify** line. Don't move on until it passes.

`verify:deploy` runs from a ricotdin checkout on any machine with Node 20 (read-only, no secrets).
Run `npm ci` once first (`tsx` is a dev dependency):

```bash
npm run verify:deploy -- https://<ricotdin host> --expect vX.Y.Z
# PASS version / PASS health → exit 0; any FAIL → exit 1; bad arguments → exit 2.
# Without --expect it only prints the running version. "1.1.0" is read as "v1.1.0".
```

---

## One-time (2026-10): v1.1.0 by hand, first backup, pipeline setup

Do these in order. Afterwards, use **Every release** below.

### 1. Deploy v1.1.0 by hand (`docker run`)

1. **Migrations first.** In the Supabase SQL editor, run `migrations/032` → `036` in order
   (CHANGELOG `[1.1.0]` → *Checklist deploy* lists what each one does). Each of 033–036 has a
   commented-out "Verify after applying" query **near the top of the file**. Running the file does
   not run it, so copy it without the `--` and run it right after the migration. 032 has none;
   check it with:
   ```sql
   select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'meetings' and column_name = 'audio_purged_at';  -- 1
   select count(*) from pg_indexes where indexname = 'meetings_retention_purge_idx';               -- 1
   ```
   **Verify:** 032 returns `1` and `1`; 033–036 return what their files say (e.g. 033: all `false`).
2. **Pull the image** on the home server:
   ```bash
   docker pull mingming21400/ricotdin:v1.1.0
   ```
3. **Record how v1.0.0 is exposed today, then keep it for rollback.** Its name may not be
   `ricotdin`. Write down four things: its name, its network(s), its `-p` port mapping, and **how
   traffic reaches it**. Traffic arrives one of three ways: a cloudflared service pointing at a host
   port (e.g. `http://localhost:8080`), a cloudflared container on the same Docker network (e.g.
   `http://<name>:80`), or a plain host port with no tunnel. Steps 4–5 and rollback depend on
   this. Stop and rename the container right before step 4, so the downtime is only the switch:
   ```bash
   docker ps --format '{{.Names}}  {{.Image}}  {{.Ports}}  {{.Networks}}'
   docker stop <old> && docker rename <old> ricotdin-v1.0.0
   ```
   `docker inspect` prints the container's env **in plaintext**. Use it only to find the env file
   path and networks, and don't paste its output anywhere.
4. **Start v1.1.0 the same way the old one was reachable.** The container now listens on **3000**
   (it was 80 before v1.1.0). Reuse the old env file, but **remove `PORT`, `HOSTNAME`, `NODE_ENV` and
   `RICOTDIN_VERSION` from it if present**: `--env-file` overrides the image defaults, and a dev value
   breaks the bind or the health check. The `-e` flags pin them the way the OPS-05 `compose.yml` does.
   `RICOTDIN_VERSION` is what `/version.json` reports. Use the old container's name, networks and
   **host** port; only the container port changes (`80` → `3000`):
   ```bash
   docker run -d --name <old name> --restart unless-stopped \
     [--network <old network>] [-p <old host port>:3000] \
     --env-file <old env file> \
     -e NODE_ENV=production -e PORT=3000 -e HOSTNAME=0.0.0.0 \
     -e RICOTDIN_VERSION=v1.1.0 \
     mingming21400/ricotdin:v1.1.0
   ```
5. **Update the route only where it names the container port.**
   - If cloudflared pointed at a **host port** (`http://localhost:<port>`) or there is no tunnel:
     nothing to change. The host port is the same.
   - If cloudflared pointed at the **container by name** (`http://<name>:80`): change only the port to
     `:3000` in that same tunnel's *Public hostname*.
   - **Don't add ricotdin to the shared `proxy` tunnel here.** Its token is still committed in
     plaintext; ricotdin moves to that tunnel only in step 3, after the token is rotated.
6. **Verify:**
   ```bash
   docker ps --filter name=<old name> --format '{{.Names}}  {{.Status}}'   # (healthy)
   npm run verify:deploy -- https://<ricotdin host> --expect v1.1.0      # PASS + PASS
   ```
   A FAIL that mentions `RICOTDIN_VERSION` means step 4 lacked `-e RICOTDIN_VERSION=v1.1.0`.
   If `docker ps` shows `(healthy)` but `verify:deploy` can't connect, the route from step 5 is wrong.
7. **Rollback** (only if step 6 fails and can't be fixed quickly):
   `docker rm -f <old name> && docker rename ricotdin-v1.0.0 <old name> && docker start <old name>`,
   then set any cloudflared value you changed in step 5 back to what you recorded in step 3.
   Migrations 032–036 are compatible with v1.0.0: its browser code only reads these tables and writes
   through service-role routes. **Don't revert the migrations** on rollback.
8. When v1.1.0 has run cleanly for a day: `docker rm ricotdin-v1.0.0`.

### 2. First backup + restore test (OPS-03)

1. Check the one-time setup in `docs/ops/backup-restore.md` → *One-time setup* is done: age key pair
   (private key offline), R2 bucket + scoped token, GitHub Environment `backup` with its secrets.
2. Run it: `gh workflow run backup.yml --ref dev`, then `gh run watch`.
   **Verify:** the `db-backup` run is green and a new object is in the backup bucket.
3. Restore into a **scratch** Supabase project, following `docs/ops/backup-restore.md` → *Restore*.
   **Verify:** row counts match. Add a line to that file's *Restore-test log*, then tick OPS-03 in
   `ai-instruction/tracking.md`.

### 3. Deployment-repo pipeline (OPS-05), first time

1. **Rotate the Cloudflare Tunnel token** before adding ricotdin's hostname: rotate it in Zero
   Trust, move it to `TUNNEL_TOKEN` in a server env file, and check the connector history. Details are in
   `docs/ops/deployment-repo/README.md` → *Security notes*.
   **Verify:** the old token no longer connects, and `proxy` still serves the other sites.
2. **Decide on deployment PR #9 ("Add recordin").** It is a different setup (port 80,
   `/srv/recordin/recordin.env`) that conflicts with the OPS-05 drafts. Close it, or reconcile it
   with the drafts, before step 3.
3. Follow `docs/ops/deployment-repo/README.md` → *One-time setup*: server env file
   `/etc/mmlabs/ricotdin.env`, copy the two drafts in a normal PR, Supabase Site URL / redirect URLs.
   **Leave out its cloudflared step for now.** Until the pipeline has deployed, the public hostname keeps
   pointing where step 1.5 left it, at the hand-started container. `apps/ricotdin/release.env` only
   exists once PR #10 is merged, so validate the env file after the drafts are merged with:
   ```bash
   RICOTDIN_IMAGE=x docker compose -p ricotdin -f apps/ricotdin/compose.yml config --quiet
   ```
4. **First deploy:** this order keeps the hand-started container serving until compose is healthy.
   `deploy-ricotdin` checks health inside the host (`compose up --wait`), not through the public
   hostname, so the route can switch last.
   1. Merge the drafts PR. Nothing deploys yet: `deploy-ricotdin` exits with "No release.env yet".
   2. Only if the hand-started container is literally named `ricotdin` **and** is on the `web` network:
      `docker stop ricotdin` now. Otherwise both containers answer to the name `ricotdin` on `web`.
      In every other case, leave it running.
      Stopping it means **downtime** from now until compose is healthy in 4.3: pick a quiet moment.
   3. Merge deployment PR #10 `ricotdin v1.1.0` and watch the `deploy-ricotdin` run.
      - On `no-previous` (the first run has nothing to restore): `docker compose -p ricotdin down`. If
        you stopped it in 4.2, `docker start ricotdin`. The route was never changed, so traffic is
        back on the hand-started v1.1.0. Fix, then re-run.
      - On a `deployed` comment, continue.
   4. **Switch the route** (the README's cloudflared step): in the `proxy` tunnel (token rotated in
      step 3.1), set the ricotdin public hostname's service to `http://ricotdin:3000`. A hostname
      belongs to one tunnel, so remove it from the old tunnel / route recorded in step 1.3 in the same
      change.
   5. **Verify:** `npm run verify:deploy -- https://<ricotdin host> --expect v1.1.0` → PASS + PASS.
      Then stop and remove the hand-started container (`docker rm -f <old name>`). If verify fails,
      put the route back to step 1.3's value; the hand-started container is still there. If you
      stopped it in 4.2, first `docker compose -p ricotdin down` (the names clash), then
      `docker start ricotdin`.
      Keep the overlap short: while both containers run, two job workers poll the queue. That is safe
      (`claim_next_job` uses `FOR UPDATE SKIP LOCKED`, and both run v1.1.0), but there is no reason to
      keep it.
   Optionally, paste the README's *Verification prompt* into Claude Code.

---

## Every release (after OPS-05 is in place)

1. **Release** per `CLAUDE.md` §9k: PR `dev → main`, merge, cut or update `release/X.Y`, then tag
   `vX.Y.Z`.
   **Verify:** the `Release` workflow is green and deployment PR `ricotdin vX.Y.Z` is open.
2. **Migrations first:** run every migration in CHANGELOG `[X.Y.Z]` → *Checklist deploy*, each with
   its verification query. Do the dashboard and env steps from the same checklist.
   **Verify:** all verification queries pass.
3. **Deploy:** merge deployment PR `ricotdin vX.Y.Z`.
   **Verify:** the `deploy-ricotdin` run is green and the PR has a `deployed` comment (not `restored`).
4. **Check the live app:**
   `npm run verify:deploy -- https://<ricotdin host> --expect vX.Y.Z` → PASS + PASS.
5. **Rollback** if needed: `docs/ops/deployment-repo/README.md` → *Rollback*. This is only safe if
   no destructive migration ran in between.
6. Keep backups running. After a release with migrations, the next nightly `db-backup` run should be
   green.
