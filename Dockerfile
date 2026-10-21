# ===== Build Stage =====
FROM node:20-alpine AS builder



WORKDIR /app



COPY package*.json ./



RUN npm install



COPY . .



# NEXT_PUBLIC_* vars must be baked in at build time (they get bundled into the
# client JS). recording-app only ships the two public Supabase values to the
# browser; every other secret is server-only and injected at runtime by k8s.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY



RUN npm run build





# ===== Runtime Stage =====
FROM node:20-alpine



WORKDIR /app



# ffmpeg + ffprobe are REQUIRED at runtime: the processing pipeline transcodes
# uploaded audio (lib/audio/binaries.ts invokes bare `ffmpeg`/`ffprobe` from
# PATH on Linux). Without this, transcoding silently fails and Speechmatics
# rejects the raw audio. The alpine `ffmpeg` package provides both binaries.
RUN apk add --no-cache ffmpeg



# Copy standalone server + static assets from build stage
COPY --from=builder /app/dist/standalone ./
COPY --from=builder /app/dist/static ./dist/static
COPY --from=builder /app/public ./public



# Rolling application logs are written here at runtime (see lib/logging).
# Mirrors the elearning-service logback convention (./home/logs). The directory
# is container-local and ephemeral; downloaded/viewed on demand via /admin/logs.
#RUN mkdir -p /app/home/logs
#ENV LOG_DIR=/app/home/logs



# Server-only env vars (SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY,
# SPEECHMATICS_API_KEY, KEY_ENCRYPTION_SECRET, R2_*) are injected at runtime by
# Kubernetes — they are never baked into the image.
ENV PORT=80
# Next standalone binds to $HOSTNAME; Docker sets it to the container id, which
# would not answer on 127.0.0.1 (HEALTHCHECK). Listen on all interfaces.
ENV HOSTNAME=0.0.0.0
EXPOSE 80



# Commit the image was built from — fallback for GET /version.json when the
# runtime RICOTDIN_VERSION (set by the deployment repo's release.env) is empty.
# The release tag is NOT baked in: the image is promoted by digest.
ARG BUILD_COMMIT
ENV BUILD_COMMIT=$BUILD_COMMIT



# busybox wget ships with node:20-alpine. /api/health has no DB/provider calls.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/api/health || exit 1



CMD ["node", "server.js"]
 