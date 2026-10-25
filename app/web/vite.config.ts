import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// ARC-00 skeleton. Replaced/extended by the Figma Make import in ARC-11.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
