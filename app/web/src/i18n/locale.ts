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

/** PRF-06: after sign-in the account language wins. Returns the locale to switch to, or null when
 * the account has none (keep this device's) or it is already the current one. */
export function accountLocaleToApply(account: unknown, current: Locale): Locale | null {
  return isLocale(account) && account !== current ? account : null
}
