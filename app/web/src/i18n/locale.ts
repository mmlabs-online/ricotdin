export const LOCALES = ['en', 'vi'] as const
export type Locale = (typeof LOCALES)[number]
export const LOCALE_STORAGE_KEY = 'ricotdin-locale'

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/** Stored choice → first supported browser language → English. */
export function resolveLocale(stored: string | null | undefined, browser: readonly string[]): Locale {
  if (isLocale(stored)) return stored
  for (const tag of browser) {
    const base = tag.toLowerCase().split('-')[0]
    if (isLocale(base)) return base
  }
  return 'en'
}
