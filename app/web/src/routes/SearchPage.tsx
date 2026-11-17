// Library-wide search (PRO-05): keyword + semantic search in transcripts, summaries and notes of
// every meeting the caller can see; results grouped by meeting, transcript hits open at the second,
// summary / notes hits on their tab. The URL (`?q=&folder=`) is the source of truth.
import { useId, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '../api/errors'
import { useFolders } from '../api/meetings'
import { useSearch, type SearchItem } from '../api/search'
import { Button } from '../components/ui/Button'
import { formatClock } from '../lib/media/seek'
import { highlightParts, MAX_QUERY, readSearchParams, resultHref, searchHref, validQuery } from '../lib/search/search'
import { displayText } from '../lib/text'
import { useDocumentTitle } from '../lib/useDocumentTitle'

function errorKey(err: unknown): string {
  if (err instanceof ApiError && err.status === 400) return 'searchPage.errors.query'
  if (err instanceof ApiError && err.status === 429) return 'searchPage.errors.rateLimited'
  if (err instanceof ApiError && err.status === 0) return 'searchPage.errors.network'
  return 'searchPage.errors.generic'
}

export function SearchPage() {
  const { t, i18n } = useTranslation()
  useDocumentTitle('searchPage.title')
  const location = useLocation()
  const navigate = useNavigate()
  const { q, folder } = readSearchParams(location.search)
  const [draft, setDraft] = useState(q)
  const [seen, setSeen] = useState(q)
  if (seen !== q) {
    // back / forward changed the URL: show its query in the box
    setSeen(q)
    setDraft(q)
  }
  const [tooShort, setTooShort] = useState(false)
  const folders = useFolders()
  const result = useSearch(q, folder)
  const ids = { input: useId(), folder: useId(), hint: useId() }
  const fmt = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', { dateStyle: 'medium' })

  function go(nextQ: string, nextFolder: string) {
    if (!validQuery(nextQ)) return setTooShort(true)
    setTooShort(false)
    void navigate(searchHref(nextQ, nextFolder))
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    go(draft, folder)
  }

  const active = validQuery(q)
  const data = result.data
  const stale = result.isPlaceholderData // the rows of the previous query, while this one loads
  const loading = active && (result.isPending || stale)
  const failed = active && result.isError && !result.isFetching
  const noRetry = result.error instanceof ApiError && (result.error.status === 429 || result.error.status === 400)
  const groups = data && !stale ? data.groups : (data?.groups ?? [])
  // one always-rendered status line: searching → count / nothing found / error
  const status = !active
    ? ''
    : loading
      ? t('searchPage.searching')
      : failed
        ? t(errorKey(result.error))
        : data
          ? data.groups.length === 0
            ? t('searchPage.empty')
            : t('searchPage.count', { count: data.groups.length, query: data.query })
          : ''

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">{t('page.workspace')}</span>
          <h1>{t('searchPage.title')}</h1>
          <p>{t('searchPage.subtitle')}</p>
        </div>
      </div>

      <form className="search-form" role="search" onSubmit={submit}>
        <label className="search" htmlFor={ids.input}>
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">{t('searchPage.label')}</span>
          <input
            id={ids.input}
            type="search"
            enterKeyHint="search"
            autoFocus={!q}
            value={draft}
            maxLength={MAX_QUERY}
            onChange={(e) => {
              setDraft(e.target.value)
              if (tooShort) setTooShort(false)
            }}
            placeholder={t('searchPage.placeholder')}
            aria-describedby={tooShort ? ids.hint : undefined}
            aria-invalid={tooShort || undefined}
          />
        </label>
        <label className="sr-only" htmlFor={ids.folder}>
          {t('searchPage.folder')}
        </label>
        <select
          id={ids.folder}
          className="search-folder"
          value={folder}
          // the typed text when it is a query, else the one on screen (never a half-typed mix)
          onChange={(e) => go(validQuery(draft) ? draft : q, e.target.value)}
        >
          <option value="">{t('searchPage.allFolders')}</option>
          {(folders.data ?? []).map((f) => (
            <option key={f.id} value={f.id}>
              {displayText(f.name)}
            </option>
          ))}
        </select>
        <Button variant="primary" type="submit">
          {t('searchPage.submit')}
        </Button>
      </form>
      <p id={ids.hint} className={tooShort ? 'form-note error' : 'sr-only'} role="alert">
        {tooShort ? t('searchPage.tooShort') : ''}
      </p>

      <p className={active ? 'search-count' : 'sr-only'} role="status">
        {status}
      </p>

      {!active ? (
        <p className="tab-note">{t('searchPage.intro')}</p>
      ) : (
        <>
          {failed && !noRetry && (
            <div className="search-actions">
              <Button onClick={() => void result.refetch()}>{t('common.tryAgain')}</Button>
            </div>
          )}
          {data?.semanticAvailable === false && !stale && (
            <p className="notice-banner warning">{t('searchPage.keywordOnly')}</p>
          )}
          {data && !failed && data.groups.length === 0 && !loading && folder && (
            <div className="search-actions">
              <Button onClick={() => go(q, '')}>{t('searchPage.allFoldersAction')}</Button>
            </div>
          )}
          {groups.length > 0 && !failed && (
            <ul className={stale ? 'search-results stale' : 'search-results'} aria-busy={loading}>
              {groups.map((g) => (
                <li key={g.meetingId} className="search-group">
                  <div className="search-group-head">
                    <Link className="search-meeting bidi-isolate" to={`/meetings/${encodeURIComponent(g.meetingId)}`}>
                      {displayText(g.title)}
                    </Link>
                    <small>{fmt.format(new Date(g.createdAt))}</small>
                  </div>
                  <ul>
                    {g.items.map((item, i) => (
                      <li key={`${item.kind}-${item.startMs ?? 'x'}-${i}`}>
                        <ResultItem meetingId={g.meetingId} item={item} />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  )
}

function ResultItem({ meetingId, item }: { meetingId: string; item: SearchItem }) {
  const { t } = useTranslation()
  const where =
    item.kind === 'transcript' && item.startMs !== null
      ? t('searchPage.at', { time: formatClock(item.startMs / 1000) })
      : t(`searchPage.kind.${item.kind}`)
  return (
    <Link className="search-hit" to={resultHref(meetingId, item)}>
      <span className="search-hit-where">
        {where}
        {item.source === 'semantic' && <span className="search-hit-related"> · {t('searchPage.related')}</span>}
      </span>
      <span className="search-hit-text bidi-isolate">
        {/* ranges index the raw text: clean each part, not the whole */}
        {highlightParts(item.text, item.ranges).map((p, i) =>
          p.mark ? <mark key={i}>{displayText(p.text)}</mark> : <span key={i}>{displayText(p.text)}</span>,
        )}
      </span>
    </Link>
  )
}
