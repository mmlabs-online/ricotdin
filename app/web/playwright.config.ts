// End-to-end core flow (ARC-13c). Runs the production build (`vite preview`) against the
// test-only API `app/api/tests/e2e_server.py` (scratch database; storage, AI and worker stood
// in). Needs DATABASE_URL (a Postgres 18 + pgvector server whose scratch databases it may create)
// and a built app (`npm run build`). Run: `npm run e2e`.
import { defineConfig, devices } from '@playwright/test'

const WEB = 'http://localhost:4173'

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: { baseURL: WEB, trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  webServer: [
    {
      command: 'uv run python -m tests.e2e_server',
      cwd: '../api',
      url: 'http://127.0.0.1:8000/health',
      env: { E2E_WEB_ORIGIN: WEB, E2E_PORT: '8000' },
      timeout: 120_000,
      reuseExistingServer: false,
      // SIGTERM lets uvicorn return, so the server drops its scratch database and logins
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    },
    {
      command: 'npx vite preview --port 4173 --strictPort',
      url: WEB,
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
})
