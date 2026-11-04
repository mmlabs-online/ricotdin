import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

/** Page header from the Make design + a "being connected" note until ARC-13/14 wire the screen. */
export function PlaceholderPage({ eyebrowKey = 'page.workspace', titleKey, subtitleKey, children }: {
  eyebrowKey?: string
  titleKey: string
  subtitleKey?: string
  children?: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <>
      {children}
      <div className="page-head">
        <div>
          <span className="eyebrow">{t(eyebrowKey)}</span>
          <h1>{t(titleKey)}</h1>
          {subtitleKey && <p>{t(subtitleKey)}</p>}
        </div>
      </div>
      <div className="empty">
        <p>{t('page.comingSoon')}</p>
      </div>
    </>
  )
}
