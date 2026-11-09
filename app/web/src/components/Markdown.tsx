// Renders AI-written text (notes, chat answers) from lib/markdown.ts: React elements only, no
// HTML, no images (§0.8). Links only with `links` (summary / notes, PRO-06): https only, the host
// shown next to the text, opened in a new tab without referrer or opener. Chat never passes it.
import { Fragment, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { blockedLinkSet, parseMarkdown, type Inline, type ListItem } from '../lib/markdown'
import { displayText } from '../lib/text'

const OPEN = ' ('
const CLOSE = ')'

function Inlines({ items }: { items: Inline[] }) {
  const { t } = useTranslation()
  return (
    <>
      {items.map((i, n) => {
        const text = displayText(i.text)
        if (i.kind === 'strong') return <strong key={n}>{text}</strong>
        if (i.kind === 'em') return <em key={n}>{text}</em>
        if (i.kind === 'code') return <code key={n}>{text}</code>
        if (i.kind === 'link')
          return (
            <a key={n} href={i.href} target="_blank" rel="noopener noreferrer nofollow" className="md-link">
              {text}
              <span className="md-link-host">
                {OPEN}
                {displayText(i.host)}
                {CLOSE}
              </span>
              <span className="sr-only">{t('common.opensInNewTab')}</span>
            </a>
          )
        return <Fragment key={n}>{text}</Fragment>
      })}
    </>
  )
}

/** Flat items with a depth → nested lists. */
function List({ items, ordered }: { items: ListItem[]; ordered: boolean }) {
  const Tag = ordered ? 'ol' : 'ul'
  const out: { item: ListItem; children: ListItem[] }[] = []
  const base = items[0]?.depth ?? 0
  for (const item of items) {
    const last = out[out.length - 1]
    if (last && item.depth > base) last.children.push(item)
    else out.push({ item, children: [] })
  }
  return (
    <Tag>
      {out.map(({ item, children }, n) => (
        <li key={n}>
          <Inlines items={item.inlines} />
          {children.length > 0 && <List items={children} ordered={ordered} />}
        </li>
      ))}
    </Tag>
  )
}

export function Markdown({
  source,
  className,
  links = false,
  aiLinks,
}: {
  source: string
  className?: string
  links?: boolean
  aiLinks?: readonly string[]
}) {
  const blocks = useMemo(() => parseMarkdown(source, { links, blocked: blockedLinkSet(aiLinks) }), [source, links, aiLinks])
  return (
    <div className={className ? `markdown ${className}` : 'markdown'}>
      {blocks.map((b, n) => {
        if (b.kind === 'heading') {
          const H = b.level === 3 ? 'h3' : 'h4'
          return (
            <H key={n}>
              <Inlines items={b.inlines} />
            </H>
          )
        }
        if (b.kind === 'list') return <List key={n} items={b.items} ordered={b.ordered} />
        if (b.kind === 'code') return <pre key={n}>{displayText(b.text)}</pre>
        return (
          <p key={n}>
            <Inlines items={b.inlines} />
          </p>
        )
      })}
    </div>
  )
}
