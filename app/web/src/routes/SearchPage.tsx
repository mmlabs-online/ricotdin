// Library-wide search (PRO-05): keyword + semantic search in transcripts, summaries and notes of
// every meeting the caller can see; results grouped by meeting, transcript hits open at the second.
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
  const [tooShort, setTooShort] = useState(false)
  const folders = useFolders()
  const result = useSearch(q, folder)
  const ids = { input: useId(), folder: useId(), hint: useId() }
  const fmt = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', { dateStyle: 'medium' })

  const [seen, setSeen] = useState(q)
  if (seen !== q) {
    // back / forward changed the URL: show its query in the box
    setSeen(q)
    setDraft(q)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!validQuery(draft)) return setTooShort(true)
    setTooShort(false)
    void navigate(searchHref(draft, folder))
  }

  const groups = result.data?.groups ?? []
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
            value={draft}
            maxLength={MAX_QUERY}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('searchPage.placeholder')}
            aria-describedby={tooShort ? ids.hint : undefined}
            aria-invalid={tooShort || undefined}
          />
        </label>
        <div className="search-folder">
          <label htmlFor={ids.folder}>{t('searchPage.folder')}</label>
          <select id={ids.folder} value={folder} onChange={(e) => void navigate(searchHref(q || draft, e.target.value))}>
            <option value="">{t('searchPage.allFolders')}</option>
            {(folders.data ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {displayText(f.name)}
              </option>
            ))}
          </select>
        </div>
        <Button variant="primary" type="submit">
          {t('searchPage.submit')}
        </Button>
      </form>
      <p id={ids.hint} className={tooShort ? 'form-note error' : 'sr-only'} role="alert">
        {tooShort ? t('searchPage.tooShort') : ''}
      </p>

      {!validQuery(q) ? (
        <p className="tab-note">{t('searchPage.intro')}</p>
      ) : result.isPending ? (
        <p className="tab-note" role="status">
          {t('searchPage.searching')}
        </p>
      ) : result.isError && !result.data ? (
        <div className="empty" role="alert">
          <p>{t(errorKey(result.error))}</p>
          <Button onClick={() => void result.refetch()}>{t('common.tryAgain')}</Button>
        </div>
      ) : (
        <section aria-labelledby="search-results" aria-busy={result.isFetching}>
          <h2 id="search-results" className="search-count" aria-live="polite">
            {t('searchPage.count', { count: groups.length, query: q })}
          </h2>
          {result.data?.semanticAvailable === false && (
            <p className="notice-banner warning" role="status">
              {t('searchPage.keywordOnly')}
            </p>
          )}
          {groups.length === 0 ? (
            <p className="tab-note">{t('searchPage.empty')}</p>
          ) : (
            <ul className="search-results">
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
                      <li key={`${item.kind}-${item.startMs ?? i}`}>
                        <ResultItem meetingId={g.meetingId} item={item} />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>
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
