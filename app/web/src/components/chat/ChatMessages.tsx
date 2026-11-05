// The messages of a chat (meeting chat and the Chat page). The question is the user's own text;
// answers are untrusted AI text rendered by Markdown (no links, images or HTML, §0.8).
import type { ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ChatMessage, Citation } from '../../lib/chat/chat'
import { Markdown } from '../Markdown'

export function ChatMessages({
  messages,
  asked,
  renderCitation,
}: {
  messages: ChatMessage[]
  /** The question being sent (shown until the answer arrives). */
  asked: string | null
  renderCitation: (c: Citation) => ReactNode
}) {
  const { t } = useTranslation()
  return (
    <ol className="chat-list">
      {messages.map((m) =>
        m.role === 'user' ? (
          <li key={m.id} className="user-bubble">
            <span className="sr-only">{t('chat.you')}</span>
            {m.content}
          </li>
        ) : (
          <li key={m.id} className="assistant-row">
            <div className="ai-avatar" aria-hidden="true">
              <Sparkles size={14} />
            </div>
            <div className="answer">
              <span className="sr-only">{t('chat.assistant')}</span>
              <Markdown source={m.content} />
              {m.citations.length > 0 && (
                <ul className="citations" aria-label={t('chat.sources')}>
                  {m.citations.map((c) => (
                    <li key={c.chunkId}>{renderCitation(c)}</li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ),
      )}
      {asked && (
        <>
          <li className="user-bubble pending">
            <span className="sr-only">{t('chat.you')}</span>
            {asked}
          </li>
          <li className="assistant-row">
            <div className="ai-avatar" aria-hidden="true">
              <Sparkles size={14} />
            </div>
            <p className="answer thinking">{t('chat.thinking')}</p>
          </li>
        </>
      )}
    </ol>
  )
}
