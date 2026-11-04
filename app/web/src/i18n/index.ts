import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import vi from './locales/vi.json'
import { LOCALE_STORAGE_KEY, type Locale, resolveLocale } from './locale'

function readStored(): string | null {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY)
  } catch {
    return null
  }
}

export function initI18n(): typeof i18n {
  const lng = resolveLocale(readStored(), typeof navigator === 'undefined' ? [] : navigator.languages)
  void i18n.use(initReactI18next).init({
    resources: { en: { translation: en }, vi: { translation: vi } },
    lng,
    fallbackLng: 'en',
    interpolation: { escapeValue: false }, // React escapes
    returnNull: false,
  })
  document.documentElement.lang = lng
  return i18n
}

export function setLocale(locale: Locale): void {
  void i18n.changeLanguage(locale)
  document.documentElement.lang = locale
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // private mode: the choice lasts for this tab only
  }
}
