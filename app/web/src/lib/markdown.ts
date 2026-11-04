// A small markdown reader for AI-written text (meeting notes, chat answers; ARC-13b). Pure.
// It understands only headings, paragraphs, lists, fenced code and inline bold / italic / code.
// Links and images become their text, and HTML stays text: the text comes from an AI reading
// a transcript, so it can be steered by whoever spoke in the meeting (prompt injection). It must
// never fetch a remote image or offer a link (CLAUDE.md §0.8).

export type Inline = { kind: 'text' | 'strong' | 'em' | 'code'; text: string }
export interface ListItem {
  depth: number
  inlines: Inline[]
}
export type Block =
  | { kind: 'heading'; level: 3 | 4; inlines: Inline[] }
  | { kind: 'paragraph'; inlines: Inline[] }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'code'; text: string }

const MAX_INPUT = 200_000
const MAX_DEPTH = 2

// Every inner part is bounded (and paragraphs are capped below), so text full of stray `**` or
// `[` cannot make the scan quadratic on a long paragraph.
const INLINE =
  /!\[([^\]]{0,300})\]\([^)\s]{0,2000}\)|\[([^\]]{1,300})\]\([^)\s]{0,2000}\)|`([^`]{1,300})`|\*\*(\S(?:[^*]{0,300}?\S)?)\*\*|__(\S(?:[^_]{0,300}?\S)?)__|~~([^~]{1,300}?)~~|(?<![\w*])\*(\S(?:[^*]{0,300}?\S)?)\*(?![\w*])|(?<!\w)_(\S(?:[^_]{0,300}?\S)?)_(?!\w)/g
const MAX_PARAGRAPH = 20_000

export function parseInline(source: string): Inline[] {
  const out: Inline[] = []
  const push = (kind: Inline['kind'], text: string) => {
    if (!text) return
    const last = out[out.length - 1]
    if (kind === 'text' && last?.kind === 'text') last.text += text
    else out.push({ kind, text })
  }
  let at = 0
  for (const m of source.matchAll(INLINE)) {
    const index = m.index ?? 0
    push('text', source.slice(at, index))
    const [, image, link, code, strong1, strong2, strike, em1, em2] = m
    if (image !== undefined) push('text', image)
    else if (link !== undefined) push('text', link)
    else if (code !== undefined) push('code', code)
    else if (strong1 !== undefined || strong2 !== undefined) push('strong', strong1 ?? strong2 ?? '')
    else if (strike !== undefined) push('text', strike)
    else push('em', em1 ?? em2 ?? '')
    at = index + m[0].length
  }
  push('text', source.slice(at))
  return out
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const ORDERED = /^(\s*)\d{1,9}[.)]\s+(.*)$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const FENCE = /^\s*(```|~~~)/

export function parseMarkdown(source: string): Block[] {
  const lines = source.slice(0, MAX_INPUT).replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: Extract<Block, { kind: 'list' }> | null = null

  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', inlines: parseInline(paragraph.join(' ').slice(0, MAX_PARAGRAPH)) })
    paragraph = []
    list = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      const marker = fence[1] ?? '```'
      for (i++; i < lines.length && !(lines[i] ?? '').trimStart().startsWith(marker); i++) body.push(lines[i] ?? '')
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    if (!line.trim() || RULE.test(line)) {
      flush()
      continue
    }
    const heading = HEADING.exec(line.trim())
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: (heading[1] ?? '').length <= 2 ? 3 : 4, inlines: parseInline(heading[2] ?? '') })
      continue
    }
    const bullet = BULLET.exec(line)
    const ordered = bullet ? null : ORDERED.exec(line)
    const item = bullet ?? ordered
    if (item) {
      if (paragraph.length) flush()
      const isOrdered = ordered !== null
      if (!list || list.ordered !== isOrdered) {
        list = { kind: 'list', ordered: isOrdered, items: [] }
        blocks.push(list)
      }
      const depth = Math.min(MAX_DEPTH, Math.floor((item[1] ?? '').replace(/\t/g, '  ').length / 2))
      list.items.push({ depth, inlines: parseInline(item[2] ?? '') })
      continue
    }
    list = null
    paragraph.push(line.trim().replace(/^>\s?/, ''))
  }
  flush()
  return blocks
}
