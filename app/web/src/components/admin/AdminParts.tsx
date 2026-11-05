// Small building blocks shared by the admin screens (ARC-14).
import { useEffect, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { Status } from '../ui/Status'

/** Moves focus to the page heading when a page opens (route change), so keyboard and screen
 * reader users start at the top of the new page. */
export function useFocusTitle() {
  useEffect(() => {
    document.getElementById('admin-title')?.focus({ preventScroll: true })
  }, [])
}

export function AdminHead({ titleKey, subtitleKey, children }: { titleKey: string; subtitleKey?: string; children?: ReactNode }) {
  const { t } = useTranslation()
  useFocusTitle()
  return (
    <div className="page-head admin-heading">
      <div>
        <span className="eyebrow">{t('admin.eyebrow')}</span>
        <h1 id="admin-title" tabIndex={-1}>
          {t(titleKey)}
        </h1>
        <p>{t(subtitleKey ?? 'admin.subtitle')}</p>
      </div>
      {children}
    </div>
  )
}

export type Notice = { key: string; kind: 'success' | 'warning' | 'error'; n: number; values?: Record<string, unknown> }

/** A result banner whose same message is announced again (a new node each time). */
export function useNotice(): [Notice | null, (key: string | null, kind?: Notice['kind'], values?: Record<string, unknown>) => void] {
  const [notice, setNotice] = useState<Notice | null>(null)
  const set = (key: string | null, kind: Notice['kind'] = 'success', values?: Record<string, unknown>) =>
    setNotice((prev) => (key ? { key, kind, values, n: (prev?.n ?? 0) + 1 } : null))
  return [notice, set]
}

export function NoticeBanner({ notice, onDismiss }: { notice: Notice | null; onDismiss: () => void }) {
  const { t } = useTranslation()
  return (
    <>
      <p className="sr-only" role="status">
        {/* a fresh node per notice, so the same text is announced again */}
        {notice && notice.kind !== 'error' && <span key={notice.n}>{t(notice.key, notice.values)}</span>}
      </p>
      {notice && (
        <div key={notice.n} className={`notice-banner ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : undefined}>
          <span>{t(notice.key, notice.values)}</span>
          <Button variant="ghost" onClick={onDismiss} aria-label={t('common.dismiss')}>
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
      )}
    </>
  )
}

export function UserStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation()
  const type = status === 'active' ? 'success' : status === 'disabled' ? 'danger' : 'processing'
  return <Status type={type}>{t(`admin.users.status.${status === 'active' || status === 'disabled' ? status : 'unverified'}`)}</Status>
}

export function useFormatters() {
  const { i18n } = useTranslation()
  const lang = i18n.resolvedLanguage ?? 'en'
  return {
    date: (iso: string | null) => (iso ? new Intl.DateTimeFormat(lang, { dateStyle: 'medium' }).format(new Date(iso)) : null),
    dateTime: (iso: string | null) => (iso ? new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : null),
    number: (n: number) => new Intl.NumberFormat(lang).format(n),
  }
}
