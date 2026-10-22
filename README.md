# Ricotdin — Meeting Assistant

Record meetings in the browser → AI transcript + summary + to-dos + RAG chatbot.  
Powered by Next.js 16, Supabase, Google Gemini, and Speechmatics.

**Stack:** Next.js (App Router) · TypeScript · Supabase (Postgres + pgvector + Storage) · Docker

---

## Running with Docker (recommended)

The container runs Next.js directly on **port 3000**; Compose publishes it on host port **3333**.

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) 24+ (with Compose V2)
- A [Supabase](https://supabase.com) project
- A [Google AI Studio](https://aistudio.google.com) API key
- A [Speechmatics](https://speechmatics.com) API key

### 1 — Create `.env.local`

```dotenv
# ── Public (inlined into the browser bundle at build time) ──────────────────
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>

# ── Server-only (never sent to the browser or baked into the image) ─────────
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
GEMINI_API_KEY=<your-gemini-api-key>
SPEECHMATICS_API_KEY=<your-speechmatics-api-key>

# 64 hex chars — generate once and keep it safe:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# WARNING: losing this key makes all stored DB API keys unrecoverable.
KEY_ENCRYPTION_SECRET=<64-hex-chars>
```

> `.env.local` is in both `.dockerignore` and `.gitignore` — it is never
> baked into the image and never committed to git.

### 2 — Build and run with Compose

Compose passes `.env.local` to the build as a BuildKit secret (only its
`NEXT_PUBLIC_*` lines are read and inlined into the browser bundle) and to the
container at runtime via `env_file`. The build fails fast if the Supabase
values are empty.

```bash
# Foreground (shows logs)
docker compose up --build

# Background (detached)
docker compose up --build -d
```

Open **http://localhost:3333**.

```bash
# Tail logs
docker compose logs -f

# Rebuild after a code change
docker compose up --build -d

# Stop and remove containers
docker compose down
```

### 3 — Build and run with plain Docker

`NEXT_PUBLIC_*` vars are inlined at build time. Pass `.env.local` as a BuildKit
secret (only its `NEXT_PUBLIC_*` lines are read; nothing lands in a layer):

```bash
docker build --secret id=env,src=.env.local -t ricotdin .
```

> Changing only the `NEXT_PUBLIC_*` values in `.env.local` does not invalidate
> Docker's build cache (secret contents aren't part of the cache key). After
> changing them, rebuild with `--no-cache-filter build`
> (Compose: `docker compose build --no-cache`).

Or pass them as build args (CI does this):

```bash
docker build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="https://<ref>.supabase.co" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="<anon-key>" \
  -t ricotdin .
```

Run, injecting server-only secrets at runtime (never at build time):

```bash
docker run -d \
  -p 3333:3000 \
  --env-file .env.local \
  --name ricotdin \
  ricotdin
```

```bash
# Stop and remove
docker stop ricotdin && docker rm ricotdin
```

### Port summary

| Port | Service |
|------|---------|
| **3333** | Host port (open http://localhost:3333) |
| 3000 | Next.js inside the container (`PORT=3000`, runs as non-root `node`) |

---

## Environment variables

| Variable | Where | Description |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `--build-arg` / Compose args | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `--build-arg` / Compose args | Supabase anon key (public) |
| `SUPABASE_SERVICE_ROLE_KEY` | runtime `--env-file` | Service role key — **never expose** |
| `GEMINI_API_KEY` | runtime `--env-file` | Gemini key fallback — **never expose** |
| `SPEECHMATICS_API_KEY` | runtime `--env-file` | Speechmatics key fallback — **never expose** |
| `KEY_ENCRYPTION_SECRET` | runtime `--env-file` | 64 hex chars, encrypts stored DB keys — **never expose** |

Keys can also be managed from the admin UI at `/admin/keys` after first boot;
env vars serve as fallback when no DB keys are configured.

---

## Database setup

Apply migrations **in order** in the Supabase SQL editor:

```
migrations/001_profiles.sql
migrations/002_jwt_hook.sql
migrations/003_rls_owner_or_admin.sql
migrations/004_meetings_pinned.sql
migrations/005_audit_logs.sql
migrations/009_usage_log.sql
migrations/011_folders.sql
migrations/012_folder_shares.sql
migrations/013_folders_position.sql
migrations/014_provider_keys.sql
migrations/016_activity_log.sql
migrations/017_features.sql
migrations/018_profiles_extended.sql
migrations/019_usage_log_key.sql
```

After applying migrations:

1. **Storage bucket** — Dashboard → Storage → New bucket → Name `recordings` → uncheck "Public bucket"
2. **Auth hook** — Dashboard → Authentication → Hooks → Custom Access Token → select `public.custom_access_token_hook`
3. **Seed admin account** — `npx tsx scripts/seed-admin.ts <email>`
4. **Seed feature registry** — `npx tsx scripts/seed-features.ts`

---

## Local development (without Docker)

### Prerequisites

- Node.js 20+
- ffmpeg on `$PATH` (audio transcoding)

### Setup

```bash
npm install
# Copy .env.local from above and fill in your keys
npm run dev        # http://localhost:3000
```

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server with hot reload (port 3000) |
| `npm run build` | Production build |
| `npm run start` | Run production server (port 3000) |
| `npm run lint` | ESLint |
| `npm run check` | Verify Gemini + Supabase connectivity |
| `npm test` | Unit test suite |
