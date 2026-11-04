// Renders AI-written text (notes, chat answers) from lib/markdown.ts: React elements only, no
// HTML, no links, no images (§0.8).
import { Fragment, useMemo } from 'react'
import { parseMarkdown, type Inline, type ListItem } from '../lib/markdown'
import { displayText } from '../lib/text'

function Inlines({ items }: { items: Inline[] }) {
  return (
    <>
      {items.map((i, n) => {
        const text = displayText(i.text)
        if (i.kind === 'strong') return <strong key={n}>{text}</strong>
        if (i.kind === 'em') return <em key={n}>{text}</em>
        if (i.kind === 'code') return <code key={n}>{text}</code>
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

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
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
