// A small markdown reader for AI-written text (meeting notes, chat answers; ARC-13b). Pure.
// It understands only headings, paragraphs, lists, fenced code and inline bold / italic / code.
// Images become their text and HTML stays text: the text comes from an AI reading a transcript,
// so it can be steered by whoever spoke in the meeting (prompt injection). It never fetches a
// remote image. Links stay text too (chat, CLAUDE.md §0.8) unless the caller allows them (summary
// and notes, which people can edit, PRO-06): then only `https:` links without credentials.

export type Inline =
  | { kind: 'text' | 'strong' | 'em' | 'code'; text: string }
  | { kind: 'link'; text: string; href: string; host: string }

/** Summary / notes may carry links people typed (PRO-06); chat answers never do (§0.8). */
export interface MarkdownOptions {
  links?: boolean
  /** normalised targets that stay text even with `links` (links the AI ever wrote) */
  blocked?: ReadonlySet<string>
}

export function blockedLinkSet(raw: readonly string[] | undefined): ReadonlySet<string> {
  const out = new Set<string>()
  for (const r of raw ?? []) {
    const href = safeLinkHref(r)
    if (href) out.add(href)
  }
  return out
}

/** An `https:` URL without credentials, normalised; anything else → null (stays text). */
export function safeLinkHref(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null
  return url.href
}
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

// A backslash before punctuation shows that character as itself (CommonMark), so text written by
// the rich editor (PRO-06 6b, `lib/editor/richDoc.ts`) is never read as formatting.
// Every inner part is bounded (and paragraphs are capped below), so text full of stray `**` or
// `[` cannot make the scan quadratic on a long paragraph.
const INLINE =
  /\\([\\`*_[\]~#>+\-.()!])|!\[([^\]]{0,300})\]\([^)\s]{0,2000}\)|\[([^\]]{1,300})\]\(([^)\s]{0,2000})\)|`([^`]{1,300})`|\*\*(\S(?:[^*]{0,300}?\S)?)\*\*|__(\S(?:[^_]{0,300}?\S)?)__|~~([^~]{1,300}?)~~|(?<![\w*])\*(\S(?:[^*]{0,300}?\S)?)\*(?![\w*])|(?<!\w)_(\S(?:[^_]{0,300}?\S)?)_(?!\w)/g
const MAX_PARAGRAPH = 20_000

export function parseInline(source: string, opts: MarkdownOptions = {}): Inline[] {
  const out: Inline[] = []
  const push = (kind: 'text' | 'strong' | 'em' | 'code', text: string) => {
    if (!text) return
    const last = out[out.length - 1]
    if (kind === 'text' && last?.kind === 'text') last.text += text
    else out.push({ kind, text })
  }
  let at = 0
  for (const m of source.matchAll(INLINE)) {
    const index = m.index ?? 0
    push('text', source.slice(at, index))
    const [, escaped, image, link, target, code, strong1, strong2, strike, em1, em2] = m
    const safe = link !== undefined && opts.links ? safeLinkHref(target ?? '') : null
    const href = safe && !opts.blocked?.has(safe) ? safe : null
    if (escaped !== undefined) push('text', escaped)
    else if (image !== undefined) push('text', image)
    else if (link !== undefined && href) out.push({ kind: 'link', text: link, href, host: new URL(href).hostname })
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

const MAX_LINE = 20_000
const SPACE = (c: string | undefined) => c === ' ' || c === '\t'

// Line rules are read with plain loops, not regexes: a heading like `# a` + 20 000 spaces + `b`
// made `^(#{1,6})\s+(.*?)\s*#*\s*$` backtrack cubically (security review, CWE-1333).

function indentOf(line: string): number {
  let i = 0
  while (SPACE(line[i])) i++
  return i
}

function readHeading(line: string): { level: number; text: string } | null {
  const start = indentOf(line)
  let i = start
  while (line[i] === '#' && i - start < 7) i++
  const level = i - start
  if (level < 1 || level > 6 || !SPACE(line[i])) return null
  let text = line.slice(i).trim()
  let end = text.length
  while (end > 0 && text[end - 1] === '#') end--
  if (end === 0 || SPACE(text[end - 1])) text = text.slice(0, end).trimEnd() // closing hashes
  return { level, text }
}

function readItem(line: string): { indent: number; ordered: boolean; text: string } | null {
  const indent = indentOf(line)
  let i = indent
  const c = line[i]
  if (c === '-' || c === '*' || c === '+') {
    i++
    if (!SPACE(line[i])) return null
    return { indent, ordered: false, text: line.slice(i).trim() }
  }
  const digits = i
  while (i - digits < 10 && line[i] !== undefined && line[i]! >= '0' && line[i]! <= '9') i++
  if (i === digits || i - digits > 9 || (line[i] !== '.' && line[i] !== ')')) return null
  i++
  if (!SPACE(line[i])) return null
  return { indent, ordered: true, text: line.slice(i).trim() }
}

function isRule(line: string): boolean {
  const bare = line.replace(/[ \t]/g, '')
  if (bare.length < 3) return false
  const c = bare[0]
  if (c !== '-' && c !== '*' && c !== '_') return false
  for (const x of bare) if (x !== c) return false
  return true
}

function fenceOf(line: string): string | null {
  const t = line.trimStart()
  return t.startsWith('```') ? '```' : t.startsWith('~~~') ? '~~~' : null
}

export function parseMarkdown(source: string, opts: MarkdownOptions = {}): Block[] {
  const lines = source.slice(0, MAX_INPUT).replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: Extract<Block, { kind: 'list' }> | null = null

  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', inlines: parseInline(paragraph.join(' ').slice(0, MAX_PARAGRAPH), opts) })
    paragraph = []
    list = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').slice(0, MAX_LINE)
    const marker = fenceOf(line)
    if (marker) {
      flush()
      const body: string[] = []
      for (i++; i < lines.length && !(lines[i] ?? '').trimStart().startsWith(marker); i++) body.push(lines[i] ?? '')
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    if (!line.trim() || isRule(line)) {
      flush()
      continue
    }
    const heading = readHeading(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading.level <= 2 ? 3 : 4, inlines: parseInline(heading.text, opts) })
      continue
    }
    const item = readItem(line)
    if (item) {
      if (paragraph.length) flush()
      if (!list || list.ordered !== item.ordered) {
        list = { kind: 'list', ordered: item.ordered, items: [] }
        blocks.push(list)
      }
      const width = line.slice(0, item.indent).replace(/\t/g, '  ').length
      list.items.push({ depth: Math.min(MAX_DEPTH, Math.floor(width / 2)), inlines: parseInline(item.text, opts) })
      continue
    }
    list = null
    const text = line.trim()
    paragraph.push(text.startsWith('>') ? text.slice(1).trimStart() : text)
  }
  flush()
  return blocks
}
