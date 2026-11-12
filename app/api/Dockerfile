# syntax=docker/dockerfile:1
# Ricotdin v2 API (FastAPI, ARC-04) and pipeline worker (ARC-08). Build context: the REPO ROOT
# (the worker needs the runtime prompt ai-instruction/ai-gen/); ignore rules are in
# app/api/Dockerfile.dockerignore (BuildKit), not the root .dockerignore (v1 image).
#   docker build -f app/api/Dockerfile -t ricotdin-api:local .
#   docker run -p 8000:8000 --env-file runtime.env ricotdin-api:local          # API
#   docker run --env-file worker.env ricotdin-api:local python -m app.worker   # worker
# The worker container gets ONLY worker.env (DATABASE_URL_WORKER, KEY_ENCRYPTION_SECRET, optional
# provider key fallbacks, LOG_LEVEL, SENTRY_DSN): it refuses to start with any other credential.
# Its health check is `python -m app.worker.health` (no HTTP port); see app/api/deploy/.
# runtime.env holds ONLY runtime values (DATABASE_URL_APP/_SERVICE/_WORKER, JWT_PRIVATE_KEY,
# KEY_ENCRYPTION_SECRET, SMTP_*, MAIL_FROM, WEB_ORIGIN, ALLOWED_ORIGINS, SENTRY_DSN, optional
# provider key fallbacks GEMINI_API_KEYS / GEMINI_API_KEY_1..20 / GEMINI_API_KEY,
# SPEECHMATICS_API_KEY, OPENAI_API_KEY, XAI_API_KEY / GROK_API_KEY) — never the owner
# DATABASE_URL, so never app/api/.env. Secrets are injected at runtime only, never at build time.
# Migrations are not run on start: `alembic upgrade head` is a separate, owner-credential step.

FROM python:3.12-slim@sha256:b18b261e1b4974b4f321451ad5251ded85abb22c2b8b262da527dda1d031ab30

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_COMPILE_BYTECODE=1

# ffmpeg/ffprobe: the processing pipeline transcodes audio (ARC-08).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.11.17@sha256:03bdc89bb9798628846e60c3a9ad19006c8c3c724ccd2985a33145c039a0577b /uv /usr/local/bin/uv

WORKDIR /app
COPY app/api/pyproject.toml app/api/uv.lock app/api/.python-version ./
RUN uv sync --locked --no-dev --no-install-project

COPY app/api/alembic.ini ./
COPY app/api/app ./app
COPY app/api/migrations ./migrations
COPY app/api/scripts ./scripts
# Runtime prompt of the analyse step / regenerate (app/services/ai/prompts.py reads /app/...).
COPY ai-instruction/ai-gen ./ai-instruction/ai-gen

RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin api \
 && mkdir -p /work && chown 10001 /work  # worker job dirs (TMPDIR=/work in compose)
USER 10001

# Commit the image was built from: /version.json fallback when RICOTDIN_VERSION is unset.
ARG BUILD_COMMIT=""
ENV BUILD_COMMIT=$BUILD_COMMIT \
    PATH="/app/.venv/bin:$PATH"

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3).status == 200 else 1)"]

# Behind a reverse proxy set FORWARDED_ALLOW_IPS to the proxy address (uvicorn reads it) so
# client IPs (rate limits, audit) come from X-Forwarded-For only when the proxy sent them.
CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
