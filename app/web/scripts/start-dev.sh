#!/usr/bin/env bash
# Dev only (OPS-08, pattern from tudocuatui start_dev.sh): the whole local dev loop in one terminal,
# against the PRODUCTION database through the pg tunnel. Owner only (docs/ops/self-hosted-postgres.md).
#   1. starts the pg tunnel container (127.0.0.1:15432) if it is not running
#   2. gets a dev token if it is missing or expires within 2 minutes (scripts/dev-token.sh)
#   3. starts the API (app/api, uvicorn on 127.0.0.1:8000) in the background with the runtime logins
#      from ~/.config/ricotdin/prod-tunnel.env (owner file, mode 600, outside the repo; spaceM D18)
#   4. runs `RICOTDIN_DEV_TOKEN=1 npm run dev` in the foreground; Ctrl-C stops both
#
# Usage: scripts/start-dev.sh [--with-key]
#   --with-key  also loads ~/.config/ricotdin/prod-key.env (KEY_ENCRYPTION_SECRET, the production value
#               only) for a session that needs stored provider keys or Drive. Unset by default.
#
# Guardrails: only the API runs (never the worker, migrations, tests or role scripts); never the owner
# DATABASE_URL; every login must go through 127.0.0.1:15432; files are passed to `uv run --env-file`,
# never sourced, and no value is printed. Every request writes real production data.
#
# Env (optional): RICOTDIN_DEV_DB_ENV, RICOTDIN_DEV_KEY_ENV, RICOTDIN_DEV_TOKEN_FILE,
# RICOTDIN_PG_TUNNEL (default pg-tunnel-pg-tunnel-1).
set -eu
{ set +x; } 2>/dev/null
set -o pipefail

fail() { echo "start-dev: $*" >&2; exit 1; }

with_key=0
for arg in "$@"; do
  case "$arg" in
    --with-key) with_key=1 ;;
    -h | --help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "start-dev: unknown argument '$arg' (see --help)" >&2; exit 2 ;;
  esac
done

WEB="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$(cd -P "$WEB" && pwd)"
REPO="$(cd -P "$WEB/../.." && pwd)"
API="$REPO/app/api"

# Absolute physical path of a secrets file, so the file checked is the file uv loads after `cd "$API"`
# and the in-repo check cannot be dodged with a relative path or a symlinked directory.
abs_file() {
  case "$1" in /*) p="$1" ;; *) p="$PWD/$1" ;; esac
  [ -L "$p" ] && fail "$p is a symlink; point at the real file."
  [ -f "$p" ] || { printf '%s' "$p"; return 0; } # owner_file reports "not found"
  d="$(cd -P "$(dirname "$p")" && pwd)" || fail "cannot resolve $p."
  printf '%s/%s' "$d" "${p##*/}"
}

DB_ENV="$(abs_file "${RICOTDIN_DEV_DB_ENV:-$HOME/.config/ricotdin/prod-tunnel.env}")"
KEY_ENV="$(abs_file "${RICOTDIN_DEV_KEY_ENV:-$HOME/.config/ricotdin/prod-key.env}")"
TOKEN_FILE="${RICOTDIN_DEV_TOKEN_FILE:-$HOME/.config/ricotdin/dev-token}"
TUNNEL="${RICOTDIN_PG_TUNNEL:-pg-tunnel-pg-tunnel-1}"
API_URL="http://127.0.0.1:8000"

# --- owner files: checked before anything starts ---------------------------
owner_file() { # path, what
  [ -f "$1" ] || fail "$2 not found: $1 (docs/ops/self-hosted-postgres.md, Local dev against production)."
  case "$1" in "$REPO"/*) fail "$1 is inside the repo; keep it in ~/.config/ricotdin/." ;; esac
  mode="$(stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || true)"
  case "$mode" in 600 | 400) ;; *) fail "$1 has mode ${mode:-unknown}; run: chmod 600 \"$1\"" ;; esac
}

owner_file "$DB_ENV" "runtime logins file"
grep -Eq '^[[:space:]]*(export[[:space:]]+)?DATABASE_URL[[:space:]]*=' "$DB_ENV" \
  && fail "$DB_ENV has the owner DATABASE_URL; only DATABASE_URL_APP/_SERVICE/_WORKER belong there."
for name in DATABASE_URL_APP DATABASE_URL_SERVICE DATABASE_URL_WORKER; do
  # Any spelling of the key counts (dotenv keeps the first one), and only ?sslmode= may follow the
  # database: asyncpg reads ?host= as another target, which would leave the tunnel.
  total="$(grep -Ec "^[[:space:]]*(export[[:space:]]+)?$name[[:space:]]*=" "$DB_ENV" || true)"
  good="$(grep -Ec "^$name=postgres(ql)?://[^@/?#[:space:]]+@127\.0\.0\.1:15432/ricotdin(\?sslmode=[a-z-]+)?$" "$DB_ENV" || true)"
  [ "$total" = 1 ] && [ "$good" = 1 ] \
    || fail "$DB_ENV needs exactly one $name pointing at @127.0.0.1:15432/ricotdin (the tunnel), no query parameter but sslmode."
done
others="$(grep -Evc '^[[:space:]]*(#|$)|^DATABASE_URL_(APP|SERVICE|WORKER)=' "$DB_ENV" || true)"
[ "$others" = 0 ] || fail "$DB_ENV may only hold DATABASE_URL_APP/_SERVICE/_WORKER."

if [ "$with_key" = 1 ]; then
  owner_file "$KEY_ENV" "key file"
  others="$(grep -Evc '^[[:space:]]*(#|$)|^KEY_ENCRYPTION_SECRET=.' "$KEY_ENV" || true)"
  keys="$(grep -Ec '^[[:space:]]*(export[[:space:]]+)?KEY_ENCRYPTION_SECRET[[:space:]]*=' "$KEY_ENV" || true)"
  [ "$others" = 0 ] && [ "$keys" = 1 ] || fail "$KEY_ENV must hold exactly one KEY_ENCRYPTION_SECRET line and nothing else."
fi

[ -f "$API/.env.local" ] || fail "app/api/.env.local not found (non-secret settings: WEB_ORIGIN, MMLABS_ISSUER, ...)."
grep -Eq '^[[:space:]]*(export[[:space:]]+)?(DATABASE_URL|KEY_ENCRYPTION_SECRET)' "$API/.env.local" \
  && fail "remove DATABASE_URL* / KEY_ENCRYPTION_SECRET from app/api/.env.local; secrets live in ~/.config/ricotdin/."

for tool in docker uv npm node curl pkill; do
  command -v "$tool" >/dev/null || fail "$tool not found."
done
curl -fsS -o /dev/null -m 2 "$API_URL/health" 2>/dev/null && fail "something already answers on $API_URL; stop it first."

# --- 1. pg tunnel ------------------------------------------------------------
if [ "$(docker inspect -f '{{.State.Running}}' "$TUNNEL" 2>/dev/null || true)" != "true" ]; then
  echo "Starting $TUNNEL ..."
  docker start "$TUNNEL" >/dev/null 2>&1 || fail "cannot start $TUNNEL. New machine: deployment repo postgres/remote/compose.yml (docker compose up -d), see postgres/REMOTE-ACCESS.md."
fi
up=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if (exec 3<>/dev/tcp/127.0.0.1/15432) 2>/dev/null; then up=1; break; fi
  sleep 1
done
[ -n "$up" ] || fail "nothing listens on 127.0.0.1:15432 ($TUNNEL)."

# --- 2. dev token --------------------------------------------------------------
token_ok() {
  [ -s "$TOKEN_FILE" ] || return 1
  TOKEN_FILE="$TOKEN_FILE" node -e '
    const t = require("fs").readFileSync(process.env.TOKEN_FILE, "utf8").trim();
    try {
      const p = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
      process.exit(typeof p.exp === "number" && p.exp * 1000 > Date.now() + 120000 ? 0 : 1);
    } catch { process.exit(1); }'
}
if ! token_ok; then
  echo "Dev token missing or expiring: signing in to mmlabs Identity."
  RICOTDIN_DEV_TOKEN_FILE="$TOKEN_FILE" "$WEB/scripts/dev-token.sh"
fi

# --- 3. API on the production database ---------------------------------------------
start_api() {
  unset DATABASE_URL DATABASE_URL_APP DATABASE_URL_SERVICE DATABASE_URL_WORKER KEY_ENCRYPTION_SECRET UV_ENV_FILE
  # (uv's --env-file never overrides a variable already in the environment, and UV_ENV_FILE would add a file)
  cd "$API"
  if [ "$with_key" = 1 ]; then
    exec uv run --env-file .env.local --env-file "$DB_ENV" --env-file "$KEY_ENV" uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000
  fi
  exec uv run --env-file .env.local --env-file "$DB_ENV" uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000
}

api_pid=""
cleanup() {
  if [ -n "$api_pid" ] && kill -0 "$api_pid" 2>/dev/null; then
    # api_pid is uv; stop its uvicorn child too, so the API never outlives this script on production.
    pkill -TERM -P "$api_pid" 2>/dev/null || true
    kill "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

start_api > >(sed -u 's/^/[api] /') 2>&1 &
api_pid=$!

echo "Waiting for the API ($API_URL/health) ..."
ready=""
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null -m 2 "$API_URL/health" 2>/dev/null; then ready=1; break; fi
  kill -0 "$api_pid" 2>/dev/null || fail "the API exited; see the [api] lines above (tunnel login expired? docker logs $TUNNEL)."
  sleep 1
done
[ -n "$ready" ] || fail "the API did not answer within 60 s."

# --- 4. SPA ------------------------------------------------------------------------
echo
echo "Open http://localhost:5173  (PRODUCTION data: every change is real)."
echo "Token expired? In another terminal: app/web/scripts/dev-token.sh, then press retry."
echo
cd "$WEB"
RICOTDIN_DEV_TOKEN=1 npm run dev
