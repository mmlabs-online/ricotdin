# syntax=docker/dockerfile:1
# Ricotdin v2 API (FastAPI) — ARC-04. Build context: app/api.
#   docker build -t ricotdin-api:local app/api
#   docker run -p 8000:8000 --env-file runtime.env ricotdin-api:local
# runtime.env holds ONLY runtime values (DATABASE_URL_APP/_SERVICE/_WORKER, JWT_PRIVATE_KEY,
# SMTP_*, MAIL_FROM, WEB_ORIGIN, ALLOWED_ORIGINS, SENTRY_DSN) — never the owner DATABASE_URL, so
# never app/api/.env. Secrets are injected at runtime only, never at build time.
# Migrations are not run on start: `alembic upgrade head` is a separate, owner-credential step.

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_COMPILE_BYTECODE=1

# ffmpeg/ffprobe: the processing pipeline transcodes audio (ARC-08).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.11.17 /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --locked --no-dev --no-install-project

COPY alembic.ini ./
COPY app ./app
COPY migrations ./migrations
COPY scripts ./scripts

RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin api
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
