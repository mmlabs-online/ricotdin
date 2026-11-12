import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  type ColorTheme,
  DARK_STORAGE_KEY,
  THEME_STORAGE_KEY,
  parseColorTheme,
  resolveDark,
  themeClasses,
} from './theme'

type ThemeValue = {
  dark: boolean
  setDark: (dark: boolean) => void
  colorTheme: ColorTheme
  setColorTheme: (theme: ColorTheme) => void
}

const ThemeContext = createContext<ThemeValue | null>(null)

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // private mode: the choice lasts for this tab only
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [colorTheme, setTheme] = useState<ColorTheme>(() => parseColorTheme(read(THEME_STORAGE_KEY)))
  const [dark, setDarkState] = useState(() =>
    resolveDark(read(DARK_STORAGE_KEY), window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false),
  )

  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('dark', 'theme-sage', 'theme-plum', 'theme-ocean')
    root.classList.add(...themeClasses(colorTheme, dark))
    root.style.colorScheme = dark ? 'dark' : 'light'
  }, [colorTheme, dark])

  const value = useMemo<ThemeValue>(
    () => ({
      dark,
      colorTheme,
      setDark: (next) => {
        setDarkState(next)
        write(DARK_STORAGE_KEY, next ? '1' : '0')
      },
      setColorTheme: (next) => {
        setTheme(next)
        write(THEME_STORAGE_KEY, next)
      },
    }),
    [dark, colorTheme],
  )
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme outside ThemeProvider')
  return value
}
