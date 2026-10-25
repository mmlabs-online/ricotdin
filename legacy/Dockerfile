# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv  (the anon key is public by design and ships in the browser bundle)
#
# Ricotdin is a Next.js app (App Router, `output: "standalone"`, `distDir: "dist"`). The build stage
# produces dist/standalone; the runner is Node on port 3000, non-root. Unlike a static SPA it NEEDS a
# Node process at runtime: API routes, auth, the processing pipeline and the job worker all run here,
# and the pipeline shells out to ffmpeg/ffprobe.
#
# EVERY `NEXT_PUBLIC_*` VALUE IS BAKED INTO THE BUNDLE AT BUILD TIME. The server that pulls this
# image cannot change them — a different Supabase project means a different image. They are public
# by design. Server-only secrets (SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY, SPEECHMATICS_API_KEY,
# KEY_ENCRYPTION_SECRET) are injected at runtime via an env file and are never part of the build.
#
# ARC-00: the app lives in legacy/ but the build context is the REPO ROOT, because the runtime
# prompt ai-instruction/ai-gen/ sits outside legacy/. Run both commands from the repo root:
# Build:  docker build -f legacy/Dockerfile --secret id=env,src=legacy/.env.local -t ricotdin:local .
# Run:    docker run -d -p 3333:3000 --env-file legacy/.env.local ricotdin:local

ARG NODE_VERSION=20

# --- deps: the full dependency tree, devDependencies included (the build needs them) ------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY legacy/package.json legacy/package-lock.json ./
RUN --mount=type=cache,id=npm-cache,target=/root/.npm \
    npm ci

# --- build ---------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app

# The `NEXT_PUBLIC_*` values come from a BuildKit secret — normally `.env.local` itself:
#
#     docker build -f legacy/Dockerfile --secret id=env,src=legacy/.env.local -t ricotdin:local .
#
# A secret is mounted for the one RUN below and is never written to a layer. ONLY the
# `NEXT_PUBLIC_*` lines are read from it: .env.local also holds the service-role and provider keys,
# and those must not be in the environment of `next build` (a server component prerendered at build
# time could otherwise bake their effects into the output).
#
# The ARGs remain for CI (release.yml / release-dev.yml pass --build-arg). A variable defined in the
# secret file wins over the same --build-arg; one the file does not define comes from the --build-arg.
#
# CACHE CAVEAT: a secret's CONTENT is not part of the layer cache key. If only the NEXT_PUBLIC_*
# values in .env.local change (no source change), the cached build is reused with the OLD values.
# After changing them, rebuild with `--no-cache-filter build` (or `docker compose build --no-cache`).
# --build-arg values ARE part of the key, so CI builds are not affected.
ARG NEXT_PUBLIC_SUPABASE_URL=""
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=""

COPY --from=deps /app/node_modules ./node_modules
COPY legacy/ .
# Runtime system prompt (read by lib/gemini/analyze.ts); next.config traces it into dist/standalone.
COPY ai-instruction/ai-gen ./ai-instruction/ai-gen

# An empty NEXT_PUBLIC_SUPABASE_URL does not fail `next build` — it ships a bundle whose browser
# client cannot reach Supabase, i.e. a broken release that looks healthy. Refuse it.
#
# `sed` strips CR so a file saved on Windows with CRLF does not put `\r` at the end of every value.
RUN --mount=type=secret,id=env,required=false \
    export NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY; \
    if [ -f /run/secrets/env ]; then \
      set -a; eval "$(sed 's/\r$//' /run/secrets/env | grep -E '^NEXT_PUBLIC_[A-Z0-9_]+=')"; set +a; \
    fi; \
    if [ -z "$NEXT_PUBLIC_SUPABASE_URL" ] || [ -z "$NEXT_PUBLIC_SUPABASE_ANON_KEY" ]; then \
      echo "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are empty: pass --secret id=env,src=legacy/.env.local from the repo root (or --build-arg NEXT_PUBLIC_SUPABASE_URL=... and NEXT_PUBLIC_SUPABASE_ANON_KEY=...)." >&2; \
      exit 1; \
    fi; \
    npm run build

# --- runner: node, non-root, port 3000 -----------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app

# ffmpeg + ffprobe are REQUIRED at runtime: the processing pipeline transcodes uploaded audio
# (lib/audio/binaries.ts invokes bare `ffmpeg`/`ffprobe` from PATH on Linux). Without them,
# transcoding fails and Speechmatics rejects the raw audio. The alpine `ffmpeg` package provides both.
RUN apk add --no-cache ffmpeg

# Next standalone binds to $HOSTNAME; Docker sets it to the container id, which would not answer on
# 127.0.0.1 (HEALTHCHECK). Listen on all interfaces.
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000

# Standalone server + static assets. Owned by the unprivileged `node` user that ships with the base
# image; at runtime the app only writes to os.tmpdir() (/tmp), which `node` can already write.
COPY --from=build --chown=node:node /app/dist/standalone ./
COPY --from=build --chown=node:node /app/dist/static ./dist/static
COPY --from=build --chown=node:node /app/public ./public

# Commit the image was built from — fallback for GET /version.json when the runtime RICOTDIN_VERSION
# (set by the deployment repo's release.env) is empty. The release tag is NOT baked in: the image is
# built before its tag exists and is promoted to :vX.Y.Z by digest without rebuilding (OPS-04).
ARG BUILD_COMMIT=""
ENV BUILD_COMMIT=$BUILD_COMMIT

USER node
EXPOSE 3000

# busybox wget ships with node:alpine. /api/health has no DB/provider calls.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
