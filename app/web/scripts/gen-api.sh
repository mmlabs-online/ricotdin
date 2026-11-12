#!/usr/bin/env bash
# Regenerate src/api/schema.d.ts from the API's OpenAPI document (ARC-11).
# openapi-typescript needs TypeScript 5's compiler API, so it runs pinned through npx instead of
# being a dependency of this TypeScript 7 project. Run after any API route/model change.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
spec="$(mktemp -d)/openapi.json"
(cd "$here/../api" && uv run python -m scripts.dump_openapi "$spec" >/dev/null)
npm_config_ignore_scripts=true npx --yes -p typescript@5.9.3 -p openapi-typescript@7.13.0 \
  openapi-typescript "$spec" -o "$here/src/api/schema.d.ts"
