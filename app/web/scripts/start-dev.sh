#!/usr/bin/env bash
# Dev only (OPS-08, same flow as tudocuatui scripts/start-dev.sh): the whole local dev loop in one terminal,
# against the PRODUCTION database through the pg tunnel. Owner only (docs/ops/self-hosted-postgres.md).
#   1. a fresh dev token (scripts/dev-token.sh); nothing else starts unless it succeeds
#   2. the pg tunnel container (production DB on 127.0.0.1:15432)
#   3. the passwords of the three runtime logins, then the API (uvicorn on 127.0.0.1:8000) in the background
#   4. `RICOTDIN_DEV_TOKEN=1 npm run dev` in the foreground; Ctrl-C stops both
#
# Usage: app/web/scripts/start-dev.sh [--with-key]
#   --with-key  also asks for KEY_ENCRYPTION_SECRET (the production value only) for a session that needs
#               stored provider keys or Drive. Unset by default.
#
# Guardrails: secrets are read with `read -s` from the terminal, exported only to the API process and never
# written to a file, printed or passed as an argument. Only the API runs (never the worker, migrations, tests
# or role scripts) and only with the runtime logins (never the owner login), always through the tunnel.
# Every request writes real production data.
#
# Env (optional): RICOTDIN_PG_TUNNEL (default pg-tunnel-pg-tunnel-1),
# RICOTDIN_DEV_TOKEN_FILE (default ~/.config/ricotdin/dev-token).
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

WEB="$(cd -P "$(dirname "$0")/.." && pwd)"
API="$(cd -P "$WEB/../api" && pwd)"
TOKEN_FILE="${RICOTDIN_DEV_TOKEN_FILE:-$HOME/.config/ricotdin/dev-token}"
TUNNEL="${RICOTDIN_PG_TUNNEL:-pg-tunnel-pg-tunnel-1}"
DB_HOST="127.0.0.1:15432"
API_URL="http://127.0.0.1:8000"

# --- checks before anything starts ------------------------------------------------
[ -f "$API/.env.local" ] || fail "app/api/.env.local not found (non-secret settings: WEB_ORIGIN, MMLABS_ISSUER, ...)."
grep -Eq '^[[:space:]]*(export[[:space:]]+)?(DATABASE_URL|KEY_ENCRYPTION_SECRET)' "$API/.env.local" \
  && fail "remove DATABASE_URL* / KEY_ENCRYPTION_SECRET from app/api/.env.local; this script asks for them at runtime."
for tool in docker uv npm node curl pkill; do
  command -v "$tool" >/dev/null || fail "$tool not found."
done
curl -fsS -o /dev/null -m 2 "$API_URL/health" 2>/dev/null && fail "something already answers on $API_URL; stop it first."

# --- 1. dev token: always sign in first; nothing else starts unless this succeeds ----
token_ok() {
  [ -s "$TOKEN_FILE" ] || return 1
  TOKEN_FILE="$TOKEN_FILE" node -e '
    const t = require("fs").readFileSync(process.env.TOKEN_FILE, "utf8").trim();
    try {
      const p = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
      process.exit(typeof p.exp === "number" && p.exp * 1000 > Date.now() + 120000 ? 0 : 1);
    } catch { process.exit(1); }'
}
echo "Step 1/4: dev token (sign in to mmlabs Identity)"
RICOTDIN_DEV_TOKEN_FILE="$TOKEN_FILE" "$WEB/scripts/dev-token.sh" || fail "dev token failed; nothing was started."
token_ok || fail "dev token file is missing or already expired after sign-in; nothing was started."

# --- 2. pg tunnel ---------------------------------------------------------------------
echo "Step 2/4: pg tunnel"
if [ "$(docker inspect -f '{{.State.Running}}' "$TUNNEL" 2>/dev/null || true)" != "true" ]; then
  echo "Starting $TUNNEL ..."
  docker start "$TUNNEL" >/dev/null 2>&1 || fail "cannot start $TUNNEL. New machine: deployment repo postgres/remote/compose.yml (docker compose up -d), see postgres/REMOTE-ACCESS.md."
fi
up=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if (exec 3<>/dev/tcp/127.0.0.1/15432) 2>/dev/null; then up=1; break; fi
  sleep 1
done
[ -n "$up" ] || fail "nothing listens on $DB_HOST ($TUNNEL)."

# --- 3. API on the production database ---------------------------------------------------
echo "Step 3/4: API (passwords of the runtime logins: ~/.config/ricotdin/db-logins.env on the Mac)"
# Reads one secret from the terminal into the shell variable $2 (never exported, never echoed).
ask() { # prompt, variable
  IFS= read -rsp "$1: " "$2" </dev/tty || fail "cannot read from the terminal."
  echo
  [ -n "${!2}" ] || fail "empty value."
}
# Runtime login URL through the tunnel; the password is URL-encoded so @ : / # % cannot change the target.
login_url() { # login, password
  enc="$(printf '%s' "$2" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.stdout.write(encodeURIComponent(s)));')"
  printf 'postgresql://%s:%s@%s/ricotdin?sslmode=disable' "$1" "$enc" "$DB_HOST"
}
ask "Password ricotdin_api_login" pw
url_app="$(login_url ricotdin_api_login "$pw")"
ask "Password ricotdin_service_login" pw
url_service="$(login_url ricotdin_service_login "$pw")"
ask "Password ricotdin_worker_login" pw
url_worker="$(login_url ricotdin_worker_login "$pw")"
unset pw enc
key=""
[ "$with_key" = 1 ] && ask "KEY_ENCRYPTION_SECRET (production value)" key

start_api() {
  # uv's --env-file never overrides a variable already in the environment, and UV_ENV_FILE would add a file:
  # drop anything inherited so only the values typed above reach the API.
  unset DATABASE_URL DATABASE_URL_APP DATABASE_URL_SERVICE DATABASE_URL_WORKER KEY_ENCRYPTION_SECRET UV_ENV_FILE
  export DATABASE_URL_APP="$url_app" DATABASE_URL_SERVICE="$url_service" DATABASE_URL_WORKER="$url_worker"
  if [ "$with_key" = 1 ]; then export KEY_ENCRYPTION_SECRET="$key"; fi
  cd "$API"
  exec uv run --env-file .env.local uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000
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
unset url_app url_service url_worker key

echo "Waiting for the API ($API_URL/health) ..."
ready=""
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null -m 2 "$API_URL/health" 2>/dev/null; then ready=1; break; fi
  kill -0 "$api_pid" 2>/dev/null || fail "the API exited; see the [api] lines above (wrong password? tunnel login expired? docker logs $TUNNEL)."
  sleep 1
done
[ -n "$ready" ] || fail "the API did not answer within 60 s."

# --- 4. SPA ------------------------------------------------------------------------------
echo
echo "Step 4/4: UI"
echo "Open http://localhost:5173  (PRODUCTION data: every change is real)."
echo "Token expired? In another terminal: app/web/scripts/dev-token.sh, then press retry."
echo
cd "$WEB"
RICOTDIN_DEV_TOKEN=1 npm run dev
