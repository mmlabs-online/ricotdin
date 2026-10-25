# ricotdin in mmlabs-online/deployment (OPS-05)

Drafts to copy into the **deployment repository** (`mmlabs-online/deployment`). They follow the
same pattern as `site` / `calechip` there; the one difference is that ricotdin is a Next.js server
that needs **runtime secrets**, which live only in a server-side env file.

| Draft (this repo) | Copy to (deployment repo) |
|---|---|
| `docs/ops/deployment-repo/apps/ricotdin/compose.yml` | `apps/ricotdin/compose.yml` |
| `docs/ops/deployment-repo/.github/workflows/deploy-ricotdin.yml` | `.github/workflows/deploy-ricotdin.yml` |

`apps/ricotdin/release.env` is **not** a draft: ricotdin's `release.yml` writes it in the
`ricotdin vX.Y.Z` PR (OPS-04). `pr-scope.yml` already accepts `release/ricotdin-v…` branches.

## How a release deploys

```
tag vX.Y.Z (ricotdin) → release.yml: verify → build & push image → PR "ricotdin vX.Y.Z" (release.env pinned by digest)
apply that release's migrations (ricotdin CLAUDE.md §9a / CHANGELOG checklist)  ← BEFORE merging
merge the PR → deploy-ricotdin (self-hosted runner mmlabs-server):
  check release.env pattern → check server env file → pull → up -d --wait (/api/health, 180 s)
  healthy → PR comment "deployed"   ·   unhealthy → restore previous release.env, redeploy it, push revert, comment "restored"
```

A restore never touches the database — every migration must stay compatible with the previous image.

## One-time setup

1. **Server env file** on the home server, at **`/etc/mmlabs/ricotdin.env`** (path is fixed in both
   drafts — change both together if you move it):
   ```bash
   sudo install -d -m 755 /etc/mmlabs
   sudo install -m 600 -o <runner-user> /dev/null /etc/mmlabs/ricotdin.env
   sudoedit /etc/mmlabs/ricotdin.env
   ```
   It must be readable by the user the `mmlabs-server` runner runs as, and by nobody else. Never
   commit it, never `cat` it in a workflow. Use **production** credentials (at least a separate
   production service-role key), not the ones from a dev laptop's `.env.local`. Variable **names**:

   | Variable | Required | Note |
   |---|---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | no effect | inlined into client AND server bundles at build time (ricotdin `release.yml` secret). Harmless here, but changing it needs a new release |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | no effect | same: build-time, public by design |
   | `SUPABASE_SERVICE_ROLE_KEY` | yes | server only |
   | `KEY_ENCRYPTION_SECRET` | yes | 64 hex chars; must be the SAME value as before, or stored keys / R2 config can't be decrypted |
   | `GEMINI_API_KEY` / `GEMINI_API_KEYS` / `GEMINI_API_KEY_1..20` | optional | env fallback only — keys are normally managed at `/admin/keys` |
   | `SPEECHMATICS_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` / `GROK_API_KEY` | optional | same: fallback only |
   | `SENTRY_DSN` | optional | error tracking |
   | `NODE_EXTRA_CA_CERTS`, `GEMINI_DEBUG`, backoff tuning vars | optional | only if you need them (TLS-inspecting proxy, debugging) |

   Do **not** put `PORT`, `HOSTNAME`, `RICOTDIN_VERSION` or `NODE_ENV` there — `compose.yml` pins them.
   **Back up the whole file offline** (password manager, or age-encrypted next to the OPS-03 key), never
   in an unencrypted host backup. Losing `KEY_ENCRYPTION_SECRET` makes every stored provider key and the
   R2 config unrecoverable — and OPS-03 DB backups can't bring them back without it. It cannot be rotated
   in place (no dual-key decrypt): a new value means re-entering every key at `/admin/keys` and the R2
   secret at `/admin/storage`.
   After editing, validate on the host (`docker compose -p ricotdin -f apps/ricotdin/compose.yml
   --env-file apps/ricotdin/release.env config --quiet`) — don't debug a malformed file in CI, where a
   parser error could echo part of a line into the log.
2. **Copy the two drafts** into the deployment repo (a normal PR, not a `release/…` branch).
3. **cloudflared route:** Cloudflare Zero Trust → Networks → Tunnels → the tunnel used by
   `proxy/compose.yml` → *Public hostname* → add `<your ricotdin hostname>` → service
   **`http://ricotdin:3000`** (service name on the `web` network). In Supabase Auth → URL
   configuration set the Site URL to that hostname and add `https://<host>/login` (or `https://<host>/**`)
   to the redirect URLs (email verification redirects to `/login`); keep localhost for dev.
4. **Runner:** `mmlabs-server` must be able to run `docker compose` and see the `web` network
   (it already does for site/calechip).

## First deploy

If `ricotdin vX.Y.Z` PR is already open (e.g. `ricotdin v1.1.0`): apply that release's migrations,
merge the drafts PR from step 2 first, then merge the release PR. Watch the `deploy-ricotdin` run;
the PR gets a `deployed` / `restored` comment. To redeploy what main pins: *Actions → deploy-ricotdin
→ Run workflow*.

**Stop any ricotdin container started by hand first.** Compose names its container `ricotdin-ricotdin-1`,
so a hand-started `ricotdin` on the `web` network would NOT clash — both would answer to the name
`ricotdin`, cloudflared would round-robin between old and new versions, and two job workers would run.
```bash
docker ps -a --filter network=web --filter name=ricotdin --format '{{.Names}}  {{.Image}}'
docker rm -f <hand-started-name>      # keep only ricotdin-ricotdin-1
```

## Rotating a server secret

1. Rotate at the provider (Supabase: create a second secret key so old and new overlap; legacy JWT
   secret rotation also invalidates the anon key and every session — plan for it). Gemini / Speechmatics /
   other provider keys are normally rotated at `/admin/keys`, not in this file.
2. `sudoedit /etc/mmlabs/ricotdin.env`, then validate (see above).
3. Redeploy: *Actions → deploy-ricotdin → Run workflow* (a push only fires on `apps/ricotdin/**`), or
   `docker compose … up -d` on the host (an env_file change recreates the container).
4. Check `/api/health`, then revoke the old key. On suspected exposure: rotate immediately and review
   Supabase logs from the exposure time.

## Security notes

- Values from `env_file` become container environment: `docker inspect` / `docker compose config`
  (without `--quiet`) show them in plaintext. Never paste that output into issues or chat.
- **Write access to the deployment repo is root on the home server**, and so reaches every ricotdin
  secret: the self-hosted deploy workflows run whatever `compose.yml` on `main` says. The deployment repo
  currently has **no branch protection** (it needs GitHub Pro/Team), and ricotdin's `DEPLOY_REPO_TOKEN`
  (Contents read/write) can push to `main`. Keep the collaborator list minimal; consider upgrading to
  enforce protected `main` + required `pr-scope` + CODEOWNERS (`/apps/ricotdin/ @owner`), or a gate in the
  deploy workflows that only deploys commits from merged, owner-approved PRs.
- **Existing issue in the deployment repo (not part of these drafts):** `proxy/compose.yml` commits the
  Cloudflare Tunnel token in plaintext. Before adding ricotdin's hostname to the tunnel: rotate the
  tunnel token in Zero Trust, move it to `TUNNEL_TOKEN` in a server env file (`env_file:` +
  `command: tunnel --no-autoupdate run`), check the connector history for unknown connectors, and add a
  secret scanner (e.g. gitleaks) to `pr-scope.yml`. Purging git history is hygiene once the old token is dead.

## Rollback

Open a PR on the deployment repo that sets `apps/ricotdin/release.env` back to the previous
release's three lines (from git history) and merge it — only safe if no destructive migration ran
in between. The automatic restore covers the "new image is unhealthy" case.

## Verification prompt

Paste into Claude Code from the **ricotdin** repo after a release (read-only; replace `<TAG>` and
`<PUBLIC_URL>`):

```
Verify that ricotdin <TAG> is really deployed. Read-only: do not push, merge, edit or re-run
anything. For every check print PASS / FAIL / CANNOT-CHECK with the evidence (command + output).
1. Release workflow: in this repo, the "Release" run for tag <TAG> succeeded
   (gh run list --workflow release.yml), and its verify + build jobs are green.
2. Image: mingming21400/ricotdin:<TAG> exists on Docker Hub; record its digest
   (docker buildx imagetools inspect).
3. Deployment PR: on mmlabs-online/deployment, PR "ricotdin <TAG>" from release/ricotdin-<TAG>
   exists, pr-scope passed, it is merged, and its only changed file is apps/ricotdin/release.env.
4. Pinned release: on main of mmlabs-online/deployment, apps/ricotdin/release.env has exactly
   three lines: the "Written by the ricotdin release workflow for <TAG>" comment,
   RICOTDIN_IMAGE=mingming21400/ricotdin:<TAG>@<digest from step 2>, RICOTDIN_VERSION=<TAG>.
5. Deploy run: the deploy-ricotdin run for that merge commit succeeded, its summary says
   "deployed", and no "Restore ricotdin" commit followed it on main.
6. Live app: GET <PUBLIC_URL>/api/health returns 200 {"status":"ok"} and
   GET <PUBLIC_URL>/version.json returns {"version":"<TAG>"}.
7. Drift: the drafts in docs/ops/deployment-repo/ match the copies in the deployment repo
   (compose.yml, deploy-ricotdin.yml); list any differences.
End with one line: DEPLOYED <TAG> or NOT DEPLOYED, plus the first failing check.
```

## Checked before handing over

- `actionlint` on `deploy-ricotdin.yml` (custom runner label `mmlabs-server` ignored) — clean.
- `docker compose -f apps/ricotdin/compose.yml --env-file release.env config --quiet` — valid; without
  release.env it fails with "RICOTDIN_IMAGE is unset".
- `docker compose … up -d --wait` with the real `v1.1.0` digest and an empty env file → container
  `healthy` as user `node`, `/version.json` → `{"version":"v1.1.0"}`.
- **Not yet exercised:** the pipeline deploy itself, and the automatic restore path. v1.1.0 is the first
  release through it, so a failure there ends in `no-previous`; `restored` is first provable on a later release.
