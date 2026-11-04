# Ricotdin web (v2, Vite + React SPA)

Foundation from ARC-11: the Figma Make design (`design/figma-make/`, kept as a read-only
reference) turned into routes, i18n (EN/VI), runtime config, a typed API client and the auth flow.
Screens are wired to the API in ARC-12/13 (user) and ARC-14 (admin).

```bash
npm ci
npm run dev                 # http://localhost:5173 — reads public/config.json (API at localhost:8000)
npm run typecheck && npm run lint && npm test && npm run build
scripts/gen-api.sh          # after an API change: regenerate src/api/schema.d.ts (needs uv)
```

For a local sign-in, the API needs `WEB_ORIGIN=http://localhost:5173` and
`ALLOWED_ORIGINS=http://localhost:5173` (the refresh cookie is host-only on `localhost`).

## Layout

| Path | What |
|---|---|
| `src/main.tsx` | loads `/config.json`, then mounts i18n → error boundary → theme → query → auth → router |
| `src/app/` | router, `AppShell` (sidebar, top bar, account menu, mobile nav), `AdminShell` |
| `src/auth/` | `AuthSession` (in-memory token, refresh), `AuthProvider`, `RequireRole`, pure guards |
| `src/api/` | `openapi-fetch` client (`client.ts`), generated `schema.d.ts`, error envelope |
| `src/i18n/` | `locales/en.json` + `vi.json` (same keys, tested), `resolveLocale` |
| `src/theme/` | four palettes × light/dark as classes on `<html>` |
| `src/styles/` | `index.css` = the Make stylesheet (admin/mobile nav selectors also match links), `app.css` = additions |

## Rules

- **No hard-coded user-facing text**: JSX text goes through `t()` (oxlint `react/jsx-no-literals`),
  and `scripts/check-i18n.mjs` rejects literal `placeholder` / `title` / `aria-label` / `alt` /
  `label`. Add a key to both locale files.
- **Auth** (CLAUDE.md §0.3): the access token lives only in memory; `/auth/refresh` runs at start
  and on a 401 (one retry), one refresh at a time across tabs (Web Lock + BroadcastChannel). Never
  store tokens in `localStorage` / `sessionStorage`.
- Use `useApi()` + TanStack Query for data; errors are `ApiError {status, code}` — map codes to
  i18n keys, never show server text as-is.
- TypeScript 7 has no compiler API yet, so ESLint/typescript-eslint and openapi-typescript cannot
  be dependencies: lint is oxlint, and `gen-api.sh` runs openapi-typescript pinned through npx.
  CI (`ci-api.yml`) fails if `schema.d.ts` is stale.

## Image

`docker build -t ricotdin-web app/web` → nginx (unprivileged, port 8080). Runtime env:
`RICOTDIN_API_URL` (required, https origin) and optional `RICOTDIN_AUTH_URL` (defaults to the API
URL). nginx answers `/config.json` from them and puts them in the CSP (`connect-src`, `img-src`,
`media-src`), so one image serves staging and production. A missing or malformed value stops the
container. `index.html` / routes / `config.json` are `no-store`; `/assets/*` immutable;
`/healthz` for the health check.
