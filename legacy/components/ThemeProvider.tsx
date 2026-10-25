'use client'

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { type Theme, DEFAULT_THEME, STORAGE_KEY } from '@/lib/theme'

const VALID: Theme[] = ['luxury', 'default', 'playful']

type ThemeContextValue = {
  theme: Theme
  setTheme: (next: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

/**
 * Holds the active theme. The initial value comes from the server (read from a
 * cookie in the root layout and applied to <html data-theme> during SSR), so the
 * first client render matches the server — no flash, no hydration mismatch, and
 * no inline anti-flash <script> needed.
 */
export function ThemeProvider({
  initialTheme,
  children,
}: {
  initialTheme: Theme
  children: ReactNode
}) {
  const [theme, setThemeState] = useState<Theme>(initialTheme)

  const setTheme = useCallback((next: Theme) => {
    if (!VALID.includes(next)) return
    setThemeState(next)
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', next)
      try { localStorage.setItem(STORAGE_KEY, next) } catch { /* storage blocked */ }
      // Persist to a cookie so the server can render the correct theme next load.
      document.cookie = `${STORAGE_KEY}=${next}; path=/; max-age=31536000; samesite=lax`
    }
  }, [])

  // Migrate existing users who have a localStorage preference but no cookie yet.
  // Runs post-hydration, so it can't cause an SSR mismatch.
  useEffect(() => {
    const hasCookie = document.cookie.split('; ').some((c) => c.startsWith(`${STORAGE_KEY}=`))
    if (hasCookie) return
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as Theme | null
      if (stored && VALID.includes(stored) && stored !== theme) setTheme(stored)
    } catch { /* storage blocked */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}

export { DEFAULT_THEME }
