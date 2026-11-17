#!/usr/bin/env bash
# Dev only (OPS-08, ported from tudocuatui T-025): sign in to mmlabs Identity and write a 15-minute
# ricotdin bearer token to a file that the dev server proxy (`RICOTDIN_DEV_TOKEN=1 npm run dev`,
# dev/devTokenProxy.ts) reads on every request. The token never goes to the browser, the repo or stdout.
#
# - Any mmlabs account that is a ricotdin member; re-run with another email to switch accounts.
#   The local API may use the production database (docs/ops/self-hosted-postgres.md, guardrails).
# - Sets the production Origin and X-MM-App because Identity cannot register a localhost origin.
# - The password is read with `read -s`; it reaches curl only through a pipe (printf is a builtin, so it is in
#   no process argument list) and is never written to a file.
# - Identity asks for Turnstile after 3 failed sign-ins: sign in once on the production site, then retry.
#
# Env: RICOTDIN_DEV_EMAIL (else asked), RICOTDIN_DEV_TOKEN_FILE (default ~/.config/ricotdin/dev-token).
set -eu
{ set +x; } 2>/dev/null
set -o pipefail

IDENTITY="https://api.mmlabs.online/api/v1"
APP="ricotdin"
ORIGIN="https://ricotdin.mmlabs.online"
FILE="${RICOTDIN_DEV_TOKEN_FILE:-$HOME/.config/ricotdin/dev-token}"
UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

umask 077
work="$(mktemp -d)"
tmp=""
trap 'rm -rf "$work"; rm -f "${tmp:-}"' EXIT
trap 'exit 130' INT TERM HUP
jar="$work/jar"
resp="$work/resp"

die() {
  echo "dev-token: $*" >&2
  exit 1
}

# Prints the Identity error code (a-z and _ only) of the response body, or "unknown".
error_code() {
  node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).error.code;process.stdout.write(/^[a-z_]{1,40}$/.test(c)?c:"unknown")}catch(e){process.stdout.write("unknown")}' "$resp"
}

# POST JSON on stdin to $IDENTITY$1 with the production Origin and the cookie jar; prints the HTTP status.
post() {
  curl -sS --max-time 20 -X POST "$IDENTITY$1" \
    -H 'Content-Type: application/json' -H "X-MM-App: $APP" -H "Origin: $ORIGIN" \
    -c "$jar" -b "$jar" --data-binary @- -o "$resp" -w '%{http_code}'
}

email="${RICOTDIN_DEV_EMAIL:-}"
if [ -z "$email" ]; then
  printf 'Email: ' >&2
  IFS= read -r email </dev/tty
fi
printf 'Password: ' >&2
IFS= read -rs pw </dev/tty
printf '\n' >&2

status="$(printf '%s\n%s' "$email" "$pw" |
  node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const i=d.indexOf("\n");process.stdout.write(JSON.stringify({email:d.slice(0,i),password:d.slice(i+1)}))})' |
  post /auth/login)" || die "could not reach Identity"
unset pw

if [ "$status" != "200" ]; then
  code="$(error_code)"
  case "$status:$code" in
    401:*) die "wrong email or password" ;;
    *:turnstile_required | *:turnstile_failed | 429:* | *:rate_limited)
      die "Identity wants Turnstile (3 failed sign-ins): sign in once at $ORIGIN, then retry" ;;
    *) die "sign-in failed (HTTP $status, $code)" ;;
  esac
fi

account_id="$(node -e 'try{const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).account_id;process.stdout.write(typeof a==="string"?a:"")}catch(e){}' "$resp")"
[[ "$account_id" =~ $UUID_RE ]] || die "unexpected sign-in answer"

status="$(printf '{"audience":"%s","account_id":"%s"}' "$APP" "$account_id" | post /auth/token)" ||
  die "could not reach Identity"
[ "$status" = "200" ] || die "token request failed (HTTP $status, $(error_code))"

# Validates token_type, audience and the JWT shape; prints "<token> <expires_in>".
out="$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const ok=j.token_type==="Bearer"&&j.audience===process.argv[2]&&typeof j.access_token==="string"&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(j.access_token)&&Number.isFinite(j.expires_in);if(!ok)process.exit(1);process.stdout.write(j.access_token+" "+j.expires_in)}catch(e){process.exit(1)}' "$resp" "$APP")" ||
  die "unexpected token answer"
token="${out%% *}"
expires_in="${out##* }"

# Best effort: the server verifies the JWT locally, so ending the Identity session does not revoke it (A8).
printf '{"account_id":"%s"}' "$account_id" | post /auth/logout >/dev/null 2>&1 || true

mkdir -p "$(dirname "$FILE")"
# A fresh 0600 file (never a pre-existing, predictable name), renamed atomically.
tmp="$(mktemp "$(dirname "$FILE")/.dev-token.XXXXXX")"
chmod 600 "$tmp"
printf '%s\n' "$token" >"$tmp"
mv "$tmp" "$FILE"
tmp=""
echo "dev-token: wrote $FILE (valid for ${expires_in}s)"
