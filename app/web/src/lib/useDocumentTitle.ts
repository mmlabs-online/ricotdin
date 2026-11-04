import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

/** "<page> · Ricotdin" in the current language (WCAG 2.4.2). */
export function useDocumentTitle(titleKey: string): void {
  const { t, i18n } = useTranslation()
  useEffect(() => {
    document.title = `${t(titleKey)} · ${t('app.name')}`
  }, [t, titleKey, i18n.resolvedLanguage])
}
