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
# uv prints the text of a line it cannot parse: a stray pasted secret would land in the terminal. Report
# line numbers only.
bad_lines="$(grep -nEv '^[[:space:]]*(#|$)|^[A-Z][A-Z0-9_]*=' "$API/.env.local" | cut -d: -f1 | tr '\n' ' ' || true)"
[ -z "$bad_lines" ] || fail "app/api/.env.local line(s) ${bad_lines}are not NAME=value (a pasted value?); fix them, uv would print them."
for tool in docker uv npm node curl pkill pgrep; do
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
# The Cloudflare Access session lasts 24 h; once it is over cloudflared logs "websocket: bad handshake"
# and, on the next connection, the login link (not a secret: it only starts the email one-time PIN).
access_hint() {
  logs="$(docker logs --since 10m "$TUNNEL" 2>&1 || true)"
  link="$(printf '%s\n' "$logs" | grep -oE 'https://db\.mmlabs\.online/cdn-cgi/access/cli[^[:space:]"]*' | tail -1 || true)"
  if [ -n "$link" ]; then
    echo "start-dev: Cloudflare Access login needed. Open this link, enter the emailed code, then run again:" >&2
    echo "  $link" >&2
  elif printf '%s\n' "$logs" | grep -q 'bad handshake'; then
    echo "start-dev: the Cloudflare Access login expired (\"bad handshake\" in docker logs $TUNNEL)." >&2
    echo "  Run: docker restart $TUNNEL && sleep 3 && (exec 3<>/dev/tcp/127.0.0.1/15432) ; docker logs --tail 20 $TUNNEL" >&2
    echo "  and open the https://db.mmlabs.online/cdn-cgi/access/cli... link it prints." >&2
  fi
}
# cloudflared accepts the local TCP connection even when it cannot reach db.mmlabs.online (Access login
# expired, tunnel still starting), so an open port proves nothing: Postgres must answer an SSLRequest
# (8 bytes) with one byte, N or S.
pg_answers() {
  local req='\000\000\000\010\004\322\026\057'
  (exec 3<>/dev/tcp/127.0.0.1/15432 && printf "$req" >&3 && IFS= read -r -t 8 -n 1 _ <&3) 2>/dev/null
}
up=""
for _ in 1 2 3 4 5 6; do
  if pg_answers; then up=1; break; fi
  sleep 2
done
[ -n "$up" ] || { access_hint; fail "Postgres does not answer through $DB_HOST (deployment repo postgres/REMOTE-ACCESS.md)."; }

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
# provision_db_roles makes secrets.token_urlsafe(32): 43 characters of A-Z a-z 0-9 - _. Catches a pasted
# whole URL, quotes or a stray space before the API fails with "password authentication failed".
ask_login() { # login
  ask "Password $1" pw
  [[ "$pw" =~ ^[A-Za-z0-9_-]{43}$ ]] \
    || fail "that is not a $1 password (expected 43 characters A-Z a-z 0-9 - _, got ${#pw}): paste only the part between '$1:' and '@'."
}
ask_login ricotdin_api_login
url_app="$(login_url ricotdin_api_login "$pw")"
ask_login ricotdin_service_login
url_service="$(login_url ricotdin_service_login "$pw")"
ask_login ricotdin_worker_login
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
    kids="$(pgrep -P "$api_pid" || true)"
    pkill -TERM -P "$api_pid" 2>/dev/null || true
    kill "$api_pid" 2>/dev/null || true
    # uvicorn ignores SIGTERM while its startup waits on the database: give it 10 s, then SIGKILL.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$api_pid" 2>/dev/null || break
      sleep 1
    done
    # shellcheck disable=SC2086
    kill -KILL "$api_pid" $kids 2>/dev/null || true
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
for _ in $(seq 1 120); do
  if curl -fsS -o /dev/null -m 2 "$API_URL/health" 2>/dev/null; then ready=1; break; fi
  kill -0 "$api_pid" 2>/dev/null || { access_hint; fail "the API exited; see the [api] lines above (wrong password?)."; }
  sleep 1
done
[ -n "$ready" ] || { access_hint; fail "the API did not answer within 120 s (see the [api] lines above)."; }

# --- 4. SPA ------------------------------------------------------------------------------
echo
echo "Step 4/4: UI"
echo "Open http://localhost:5173  (PRODUCTION data: every change is real)."
echo "Token expired? In another terminal: app/web/scripts/dev-token.sh, then press retry."
echo
cd "$WEB"
RICOTDIN_DEV_TOKEN=1 npm run dev
