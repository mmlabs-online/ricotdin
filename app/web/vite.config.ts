import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { sourcemap: false },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
