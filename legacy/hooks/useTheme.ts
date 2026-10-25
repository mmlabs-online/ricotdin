'use client'

// Theme state now lives in the ThemeProvider context (seeded from a cookie on
// the server) so SSR and the client agree. This re-export keeps existing
// `@/hooks/useTheme` imports working.
export { useTheme } from '@/components/ThemeProvider'
