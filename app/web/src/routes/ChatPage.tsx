// Chat page (ARC-13c, Make ChatView): ask across all meetings you can see, or one folder.
// Answers cite moments that open the meeting at that time.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { ArrowUpRight, Play, Plus, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAskScope, useScopeChat, type SessionRef } from '../api/chat'
import { useFolders, useMeetings } from '../api/meetings'
import { ChatMessages } from '../components/chat/ChatMessages'
import { Button } from '../components/ui/Button'
import { chatErrorKey, chatScope, MAX_QUESTION, questionProblem, readStoredSession, type ChatScope, type Citation } from '../lib/chat/chat'
import { formatClock, meetingSeekPath } from '../lib/media/seek'
import { displayText } from '../lib/text'
import { useDocumentTitle } from '../lib/useDocumentTitle'

const ALL_SESSION_KEY = 'ricotdin-chat-all'

function storedAllSession(): string | null {
  try {
    return readStoredSession(sessionStorage.getItem(ALL_SESSION_KEY))
  } catch {
    return null
  }
}

function storeAllSession(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(ALL_SESSION_KEY, id)
    else sessionStorage.removeItem(ALL_SESSION_KEY)
  } catch {
    // storage blocked: the chat simply starts fresh next time
  }
}

export function ChatPage() {
  useDocumentTitle('page.chat.title')
  const location = useLocation()
  const scope = chatScope(location.search)
  const key = scope.kind === 'folder' ? scope.folderId : 'all'
  return <ScopeChatView key={key} scope={scope} />
}

function ScopeChatView({ scope }: { scope: ChatScope }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const folders = useFolders()
  const meetings = useMeetings()
  const [session, setSession] = useState<SessionRef>(() => (scope.kind === 'folder' ? 'latest' : storedAllSession()))
  const chat = useScopeChat(scope, session)
  const ask = useAskScope(scope)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  const [asked, setAsked] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const inputId = useId()
  const hintId = useId()
  const scopeId = useId()
  const messages = useMemo(() => chat.data?.messages ?? [], [chat.data])
  const sessionId = chat.data?.sessionId ?? null
  const folderList = folders.data ?? []
  const folder = scope.kind === 'folder' ? folderList.find((f) => f.id === scope.folderId) : undefined
  const titles = useMemo(() => new Map((meetings.data ?? []).map((m) => [m.id, displayText(m.title)])), [meetings.data])
  const unknownFolder = scope.kind === 'folder' && folders.isSuccess && !folder

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, ask.isPending])

  function send(e?: FormEvent) {
    e?.preventDefault()
    if (ask.isPending || unknownFolder) return
    const problem = questionProblem(draft)
    if (problem) {
      setError(problem === 'empty' ? 'chat.errors.empty' : 'chat.errors.tooLong')
      return
    }
    const message = draft.trim()
    setError(null)
    setAsked(message)
    setAnnounce(t('chat.thinking'))
    ask
      .mutateAsync({ message, sessionId, prior: messages })
      .then((res) => {
        setDraft('')
        setAnnounce(t('chat.answered'))
        if (typeof res.sessionId === 'string') {
          setSession(res.sessionId)
          if (scope.kind === 'all') storeAllSession(res.sessionId)
        }
      })
      .catch((err: unknown) => {
        setError(chatErrorKey(err))
        setAnnounce('')
      })
      .finally(() => setAsked(null))
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e)
  }

  function newChat() {
    if (ask.isPending) return
    setSession(null)
    if (scope.kind === 'all') storeAllSession(null)
    setError(null)
    setAnnounce(t('chatPage.newStarted'))
    inputRef.current?.focus()
  }

  function citation(c: Citation) {
    const title = titles.get(c.meetingId)
    const time = formatClock(c.startMs / 1000)
    return (
      <Link to={meetingSeekPath(c.meetingId, c.startMs)} className="citation-link">
        {title ? t('chatPage.citation', { title, time }) : t('chatPage.citationUnknown', { time })} <Play size={11} aria-hidden="true" />
      </Link>
    )
  }

  const scopeName = scope.kind === 'folder' ? (folder ? displayText(folder.name) : t('chatPage.folderUnknown')) : t('chatPage.all')

  return (
    <div className="chat-layout">
      <aside className="chat-history" aria-label={t('chatPage.scopes')}>
        <Button variant="primary" className="full" onClick={newChat} aria-disabled={ask.isPending}>
          <Plus size={16} aria-hidden="true" /> {t('chatPage.new')}
        </Button>
        <span className="eyebrow">{t('chatPage.askAbout')}</span>
        <nav aria-label={t('chatPage.scopes')}>
          <ul className="chat-scope-list">
            <li>
              <Link to="/chat" className={scope.kind === 'all' ? 'chat-link active' : 'chat-link'} aria-current={scope.kind === 'all' ? 'page' : undefined}>
                {t('chatPage.all')}
              </Link>
            </li>
            {folderList.map((f) => {
              const active = scope.kind === 'folder' && scope.folderId === f.id
              return (
                <li key={f.id}>
                  <Link
                    to={`/chat?folder=${encodeURIComponent(f.id)}`}
                    className={active ? 'chat-link active folder-name' : 'chat-link folder-name'}
                    aria-current={active ? 'page' : undefined}
                  >
                    {displayText(f.name)}
                    {f.myRole !== 'owner' && <span className="badge">{t('meetings.folders.shared')}</span>}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>
      </aside>
      <section className="conversation" aria-labelledby={scopeId}>
        <div className="chat-head">
          <div>
            <h1 id={scopeId}>{t('page.chat.title')}</h1>
            <p>{t('chatPage.scopeLine', { scope: scopeName })}</p>
          </div>
          <label className="chat-scope-select">
            <span className="sr-only">{t('chatPage.askAbout')}</span>
            <select
              value={scope.kind === 'folder' ? scope.folderId : ''}
              onChange={(e) => void navigate(e.target.value ? `/chat?folder=${encodeURIComponent(e.target.value)}` : '/chat')}
            >
              <option value="">{t('chatPage.all')}</option>
              {scope.kind === 'folder' && !folder && <option value={scope.folderId}>{t('chatPage.folderUnknown')}</option>}
              {folderList.map((f) => (
                <option key={f.id} value={f.id}>
                  {displayText(f.name)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="sr-only" role="status">
          {announce}
        </p>
        <div className="messages" ref={listRef} tabIndex={0} role="region" aria-label={t('detail.chat.history')}>
          {unknownFolder ? (
            <div className="chat-empty">
              <strong>{t('chatPage.folderUnknown')}</strong>
              <p>{t('chatPage.folderUnknownBody')}</p>
            </div>
          ) : chat.isPending ? (
            <p className="tab-note">{t('common.loading')}</p>
          ) : chat.isError ? (
            <div className="chat-empty">
              <p>{t('detail.chat.loadError')}</p>
              <Button onClick={() => void chat.refetch()}>{t('common.tryAgain')}</Button>
            </div>
          ) : messages.length === 0 && !asked ? (
            <div className="chat-empty">
              <div className="ai-avatar" aria-hidden="true">
                <Sparkles size={16} />
              </div>
              <strong>{t('chatPage.emptyTitle')}</strong>
              <p>{t(scope.kind === 'folder' ? 'chatPage.emptyFolder' : 'chatPage.emptyAll')}</p>
            </div>
          ) : (
            <ChatMessages messages={messages} asked={asked} renderCitation={citation} />
          )}
        </div>
        {error && (
          <p className="field-error chat-error" role="alert" id={`${inputId}-error`}>
            {t(error)}
          </p>
        )}
        <form className="composer" onSubmit={send}>
          <label htmlFor={inputId} className="sr-only">
            {t('chatPage.inputLabel')}
          </label>
          <textarea
            id={inputId}
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              if (error === 'chat.errors.empty' || error === 'chat.errors.tooLong') setError(null)
            }}
            onKeyDown={onKey}
            placeholder={t('chatPage.placeholder')}
            maxLength={MAX_QUESTION}
            aria-describedby={error ? `${hintId} ${inputId}-error` : hintId}
            aria-invalid={error === 'chat.errors.empty' || error === 'chat.errors.tooLong'}
            disabled={unknownFolder}
          />
          <Button type="submit" variant="primary" aria-label={t('chat.send')} aria-disabled={ask.isPending || unknownFolder} aria-busy={ask.isPending}>
            <ArrowUpRight size={18} aria-hidden="true" />
          </Button>
          <small id={hintId}>{t('chatPage.hint')}</small>
        </form>
      </section>
    </div>
  )
}
