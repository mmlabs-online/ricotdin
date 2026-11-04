// Appearance (Figma Make design): four accent palettes, each in light and dark.
export const COLOR_THEMES = ['rose', 'sage', 'plum', 'ocean'] as const
export type ColorTheme = (typeof COLOR_THEMES)[number]
export const THEME_STORAGE_KEY = 'ricotdin-theme'
export const DARK_STORAGE_KEY = 'ricotdin-dark'

export function parseColorTheme(raw: string | null | undefined): ColorTheme {
  return (COLOR_THEMES as readonly string[]).includes(raw ?? '') ? (raw as ColorTheme) : 'rose'
}

/** Stored "1"/"0" wins; otherwise follow the operating system. */
export function resolveDark(stored: string | null | undefined, prefersDark: boolean): boolean {
  if (stored === '1') return true
  if (stored === '0') return false
  return prefersDark
}

/** Classes for <html>: `.dark` and `.theme-<name>` select the CSS variables (rose = default). */
export function themeClasses(theme: ColorTheme, dark: boolean): string[] {
  return [...(theme === 'rose' ? [] : [`theme-${theme}`]), ...(dark ? ['dark'] : [])]
}
