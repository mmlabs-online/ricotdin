// "Ask about this meeting" (RAG-01/03, Make MeetingDetail aside). Answers are AI text from the
// transcript: rendered without links or images; a citation seeks the player (§0.8).
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ArrowUpRight, MessageSquareText, Play, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAskMeeting, useMeetingChat } from '../../api/meetingDetail'
import { chatErrorKey, MAX_QUESTION, questionProblem, type Citation } from '../../lib/chat/chat'
import { formatClock } from '../../lib/media/seek'
import { ChatMessages } from '../chat/ChatMessages'
import { Button } from '../ui/Button'

export function MeetingChat({
  meetingId,
  ready,
  onCitation,
}: {
  meetingId: string
  /** Chat needs a processed meeting (embedded transcript). */
  ready: boolean
  onCitation: (c: Citation) => void
}) {
  const { t } = useTranslation()
  const chat = useMeetingChat(meetingId, ready)
  const ask = useAskMeeting(meetingId)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  const [asked, setAsked] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputId = useId()
  const hintId = useId()
  const messages = chat.data?.messages ?? []

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, ask.isPending])

  function send(e?: FormEvent) {
    e?.preventDefault()
    if (!ready || ask.isPending) return
    const problem = questionProblem(draft)
    if (problem) {
      setError(problem === 'empty' ? 'chat.errors.empty' : 'chat.errors.tooLong')
      return
    }
    const message = draft.trim()
    setError(null)
    setAsked(message)
    setAnnounce(t('chat.thinking'))
    ask.mutate(
      { message, sessionId: chat.data?.sessionId ?? null },
      {
        onSuccess: () => {
          setDraft('')
          setAnnounce(t('chat.answered'))
        },
        onError: (err) => {
          setError(chatErrorKey(err))
          setAnnounce('')
        },
        onSettled: () => setAsked(null),
      },
    )
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e)
  }

  return (
    <aside className="detail-chat" aria-labelledby={`${inputId}-title`}>
      <h2 className="section-label" id={`${inputId}-title`}>
        <MessageSquareText size={16} aria-hidden="true" />
        {t('detail.chat.title')}
      </h2>
      <p className="sr-only" role="status">
        {announce}
      </p>
      {!ready ? (
        <div className="detail-chat-empty">
          <p>{t('detail.chat.notReady')}</p>
        </div>
      ) : chat.isPending ? (
        <div className="detail-chat-empty">
          <p>{t('common.loading')}</p>
        </div>
      ) : chat.isError ? (
        <div className="detail-chat-empty">
          <p>{t('detail.chat.loadError')}</p>
          <Button onClick={() => void chat.refetch()}>{t('common.tryAgain')}</Button>
        </div>
      ) : messages.length === 0 && !asked ? (
        <div className="detail-chat-empty">
          <div className="ai-avatar" aria-hidden="true">
            <Sparkles size={16} />
          </div>
          <strong>{t('detail.chat.emptyTitle')}</strong>
          <p>{t('detail.chat.emptyBody')}</p>
        </div>
      ) : (
        <div className="detail-chat-messages" ref={listRef} tabIndex={0} role="region" aria-label={t('detail.chat.history')}>
          <ChatMessages
            messages={messages}
            asked={asked}
            renderCitation={(c) => (
              <button type="button" onClick={() => onCitation(c)} aria-label={t('chat.playFrom', { time: formatClock(c.startMs / 1000) })}>
                {formatClock(c.startMs / 1000)} <Play size={11} aria-hidden="true" />
              </button>
            )}
          />
        </div>
      )}
      {error && (
        <p className="field-error" role="alert" id={`${inputId}-error`}>
          {t(error)}
        </p>
      )}
      <form className="detail-composer" onSubmit={send}>
        <label htmlFor={inputId} className="sr-only">
          {t('detail.chat.inputLabel')}
        </label>
        <textarea
          id={inputId}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            if (error === 'chat.errors.empty' || error === 'chat.errors.tooLong') setError(null)
          }}
          onKeyDown={onKey}
          placeholder={t('detail.chat.placeholder')}
          maxLength={MAX_QUESTION}
          aria-describedby={error ? `${hintId} ${inputId}-error` : hintId}
          aria-invalid={error === 'chat.errors.empty' || error === 'chat.errors.tooLong'}
          disabled={!ready}
        />
        <Button
          type="submit"
          variant="primary"
          aria-label={t('chat.send')}
          aria-disabled={!ready || ask.isPending}
          aria-busy={ask.isPending}
        >
          <ArrowUpRight size={17} aria-hidden="true" />
        </Button>
        <small id={hintId}>{t('detail.chat.hint')}</small>
      </form>
    </aside>
  )
}
