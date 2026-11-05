// Small building blocks shared by the admin screens (ARC-14).
import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
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
    /** audio seconds as minutes, one decimal below 10 min (30 s is not 0) */
    minutes: (sec: number) => new Intl.NumberFormat(lang, { maximumFractionDigits: sec < 600 ? 1 : 0 }).format(sec / 60),
    bytes: (b: number) => {
      const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const
      let v = Math.max(0, b)
      let i = 0
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i += 1
      }
      return new Intl.NumberFormat(lang, { style: 'unit', unit: units[i], unitDisplay: 'narrow', maximumFractionDigits: i ? 1 : 0 }).format(v)
    },
    /** a `YYYY-MM-DD` the API grouped in UTC, shown as that same day */
    day: (ymd: string) => new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${ymd}T00:00:00Z`)),
    time: (ms: number) => new Intl.DateTimeFormat(lang, { timeStyle: 'medium' }).format(new Date(ms)),
  }
}

/** List filters kept in the URL (Back from a detail returns to the same list). Empty values and
 * page 1 are left out of the address. */
export function useUrlState() {
  const [params, setParams] = useSearchParams()
  const page = Math.max(1, Math.min(10_000, Number.parseInt(params.get('page') ?? '', 10) || 1))
  const set = (next: Record<string, string | number | null>) => {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '' || (k === 'page' && v === 1)) p.delete(k)
      else p.set(k, String(v))
    }
    setParams(p, { replace: true, preventScrollReset: true })
  }
  return { get: (k: string) => params.get(k), page, set }
}

/** A page past the end (rows removed meanwhile, or a hand-edited `?page=`): go to the last one. */
export function useClampPage(total: number | undefined, perPage: number, page: number, shown: number, go: (page: number) => void) {
  const last = Math.max(1, Math.ceil((total ?? 0) / perPage))
  useEffect(() => {
    if (total !== undefined && shown === 0 && page > last) go(last)
  }, [total, shown, page, last]) // eslint-disable-line react-hooks/exhaustive-deps
}

export function AdminPagination({ page, perPage, total, onPage }: { page: number; perPage: number; total: number; onPage: (page: number) => void }) {
  const { t } = useTranslation()
  const from = total === 0 ? 0 : (page - 1) * perPage + 1
  const to = Math.min(total, page * perPage)
  return (
    <nav className="pagination" aria-label={t('admin.pagination.label')}>
      <span aria-live="polite">{t('admin.pagination.range', { from, to, total })}</span>
      <Button onClick={() => page > 1 && onPage(page - 1)} aria-disabled={page <= 1}>
        {t('admin.pagination.previous')}
      </Button>
      <Button onClick={() => to < total && onPage(page + 1)} aria-disabled={to >= total}>
        {t('admin.pagination.next')}
      </Button>
    </nav>
  )
}
