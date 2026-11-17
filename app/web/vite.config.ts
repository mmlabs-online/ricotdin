import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { devTokenProxy } from './dev/devTokenProxy'

export default defineConfig({
  // devTokenProxy: dev only, inert unless RICOTDIN_DEV_TOKEN=1 (OPS-08)
  plugins: [react(), tailwindcss(), devTokenProxy()],
  build: { sourcemap: false },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'dev/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
})
