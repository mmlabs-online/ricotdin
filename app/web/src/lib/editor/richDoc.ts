// Markdown ↔ rich-text editor document (PRO-06, part 6b). Pure.
//
// Summary and notes are stored as Markdown. The editor (Tiptap / ProseMirror, JSON documents of
// the shape below) only knows what the meeting page renders (`lib/markdown.ts`): headings (shown
// as h3 / h4), paragraphs, bullet and numbered lists (3 levels), code blocks, and bold / italic /
// code / https links. Reading goes through `parseMarkdown`, so the editor starts from exactly what
// the page shows; writing escapes text so it is never read back as formatting. Formatting the page
// does not render (images, quotes, strike-through, other links) is not kept; the Markdown mode is
// there for people who want the raw text.
import { blockedLinkSet, parseInline, parseMarkdown, safeLinkHref, type Block, type Inline, type ListItem, type MarkdownOptions } from '../markdown'

/** ProseMirror JSON (what `editor.getJSON()` returns), only the fields we read. */
export interface RichNode {
  type: string
  attrs?: Record<string, unknown>
  content?: RichNode[]
  text?: string
  marks?: { type: string; attrs?: Record<string, unknown> }[]
}

const MAX_DEPTH = 2 // lib/markdown.ts renders three list levels

// --- Markdown → document ------------------------------------------------------------------------

function inlineNodes(inlines: Inline[]): RichNode[] {
  const out: RichNode[] = []
  for (const i of inlines) {
    if (!i.text) continue
    if (i.kind === 'text') out.push({ type: 'text', text: i.text })
    else if (i.kind === 'link') out.push({ type: 'text', text: i.text, marks: [{ type: 'link', attrs: { href: i.href } }] })
    else out.push({ type: 'text', text: i.text, marks: [{ type: i.kind === 'strong' ? 'bold' : i.kind === 'em' ? 'italic' : 'code' }] })
  }
  return out
}

function textBlock(type: string, inlines: Inline[], attrs?: Record<string, unknown>): RichNode {
  const content = inlineNodes(inlines)
  return { type, ...(attrs ? { attrs } : {}), ...(content.length ? { content } : {}) }
}

function listNode(ordered: boolean, items: ListItem[]): RichNode {
  const type = ordered ? 'orderedList' : 'bulletList'
  const root: RichNode = { type, content: [] }
  const stack: RichNode[] = [root] // stack[d] = the list at depth d
  for (const it of items) {
    // go one level deeper at a time, and only under an existing item
    while (it.depth > stack.length - 1) {
      const parent = stack[stack.length - 1]!.content!.at(-1)
      if (!parent) break
      const nested: RichNode = { type, content: [] }
      parent.content!.push(nested)
      stack.push(nested)
    }
    if (it.depth < stack.length - 1) stack.length = it.depth + 1
    stack[stack.length - 1]!.content!.push({ type: 'listItem', content: [textBlock('paragraph', it.inlines)] })
  }
  return root
}

function blockNode(b: Block): RichNode {
  switch (b.kind) {
    case 'heading':
      return textBlock('heading', b.inlines, { level: b.level })
    case 'paragraph':
      return textBlock('paragraph', b.inlines)
    case 'code':
      return b.text ? { type: 'codeBlock', content: [{ type: 'text', text: b.text }] } : { type: 'codeBlock' }
    case 'list':
      return listNode(b.ordered, b.items)
  }
}

/** opts = how the page renders this text: AI text (links: false) and blocked targets (links the
 *  AI ever wrote) open as plain text, so the editor never writes them back as links (security
 *  review H1). */
export function markdownToDoc(md: string, opts: MarkdownOptions): RichNode {
  const content = parseMarkdown(md, opts).map(blockNode)
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }
}

// --- document → Markdown ------------------------------------------------------------------------

// The parser's regex has no u flag: its \w is ASCII, so ours must be too (mã_số is not intraword).
const isWord = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c)
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c)

/** Escape plain text so `parseInline` shows it unchanged. `_` only where it could start formatting
 *  (snake_case stays readable); `~` always, so two pieces never join into `~~` (security review M2);
 *  a final `!`, which a following link would turn into an image. */
function escapeText(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const prev = text[i - 1]
    const next = text[i + 1]
    if (c === '\\' || c === '*' || c === '`' || c === '[') out += '\\' + c
    else if (c === '_' && !(isWord(prev) && isWord(next) && prev !== '_' && next !== '_')) out += '\\_'
    else if (c === '~' || (c === '!' && i === text.length - 1)) out += '\\' + c
    else out += c
  }
  return out
}

/** A paragraph line must not start a heading, list, quote, rule or fence (already escaped: `*`,
 *  `` ` ``, `_`, `~`). */
function escapeLineStart(line: string): string {
  const c = line[0]
  if (c === '#' || c === '>' || c === '-' || c === '+') return '\\' + line
  const num = /^(\d{1,9})([.)])/.exec(line)
  return num ? num[1] + '\\' + line.slice(num[1]!.length) : line
}

type Seg = { text: string; mark: 'bold' | 'italic' | 'code' | 'link' | null; href?: string }

function segments(nodes: RichNode[] | undefined): Seg[] {
  const out: Seg[] = []
  const walk = (list: RichNode[] | undefined) => {
    for (const n of list ?? []) {
      if (n.type === 'text') {
        const text = (n.text ?? '').replace(/\s*\n\s*/g, ' ')
        if (!text) continue
        const marks = n.marks ?? []
        const link = marks.find((m) => m.type === 'link')
        const has = (t: string) => marks.some((m) => m.type === t)
        // the page shows one kind of formatting per piece of text; the editor enforces the same
        if (has('code')) out.push({ text, mark: 'code' })
        else if (link) out.push({ text, mark: 'link', href: typeof link.attrs?.href === 'string' ? link.attrs.href : '' })
        else if (has('bold')) out.push({ text, mark: 'bold' })
        else if (has('italic')) out.push({ text, mark: 'italic' })
        else out.push({ text, mark: null })
      } else if (n.type === 'hardBreak') out.push({ text: ' ', mark: null })
      else walk(n.content)
    }
  }
  walk(nodes)
  return out
}

const fits = (s: string, banned: string) => s.length >= 1 && s.length <= 300 && !s.includes(banned) && !isSpace(s[0]) && !isSpace(s.at(-1))

function writeCode(text: string): string | null {
  return text.length <= 300 && !text.includes('`') ? '`' + text + '`' : null
}

function writeLink(text: string, href: string): string | null {
  const safe = safeLinkHref(href)
  // parentheses: the parser would cut the target, and an encoded one would no longer match the
  // blocked set (security review H1), so such a link stays text
  if (!safe || text.length > 300 || text.includes(']') || /[\s()]/.test(safe) || safe.length > 2000) return null
  return `[${text}](${safe})`
}

function writeBold(text: string): string | null {
  if (fits(text, '*')) return `**${text}**`
  if (fits(text, '_')) return `__${text}__`
  return null
}

/** `*x*` needs no word character or `*` right outside; `_x_` no word character. */
function writeItalic(text: string, before: string | undefined, after: string | undefined): string | null {
  const free = (c: string | undefined) => !isWord(c)
  if (fits(text, '*') && free(before) && free(after) && before !== '*' && after !== '*') return `*${text}*`
  if (fits(text, '_') && free(before) && free(after)) return `_${text}_`
  return null
}

function inlineMarkdown(nodes: RichNode[] | undefined): string {
  // Spaces at the edges of a mark go outside it (`** b**` is not bold on the page).
  const segs: Seg[] = []
  for (const s of segments(nodes)) {
    if (!s.mark || s.mark === 'code') {
      segs.push(s)
      continue
    }
    const lead = /^\s*/.exec(s.text)![0]
    const trail = s.text.length > lead.length ? /\s*$/.exec(s.text)![0] : ''
    const core = s.text.slice(lead.length, s.text.length - trail.length)
    if (lead) segs.push({ text: lead, mark: null })
    if (core) segs.push({ ...s, text: core })
    if (trail) segs.push({ text: trail, mark: null })
  }
  // Pass 1: everything but italic, which depends on the characters next to it.
  const parts: (string | null)[] = segs.map((s) => {
    if (s.mark === 'code') return writeCode(s.text) ?? escapeText(s.text)
    if (s.mark === 'link') return writeLink(s.text, s.href ?? '') ?? escapeText(s.text)
    if (s.mark === 'bold') return writeBold(s.text) ?? escapeText(s.text)
    if (s.mark === 'italic') return null
    return escapeText(s.text)
  })
  for (let i = 0; i < segs.length; i++) {
    if (parts[i] !== null) continue
    const before = parts[i - 1]?.at(-1)
    const after = parts[i + 1]?.[0] ?? (segs[i + 1] ? '*' : undefined) // an italic neighbour: be safe
    parts[i] = writeItalic(segs[i]!.text, before, after) ?? escapeText(segs[i]!.text)
  }
  const out = parts.join('')
  // Invariant: the page must show exactly the links the editor showed, never one more (M2).
  const wanted = segs.flatMap((s, i) => (s.mark === 'link' && parts[i]!.startsWith('[') ? [s.href] : []))
  const got = parseInline(out, { links: true }).flatMap((x) => (x.kind === 'link' ? [x.href] : []))
  if (got.length !== wanted.length || got.some((h, i) => h !== safeLinkHref(wanted[i] ?? ''))) return escapeText(segs.map((s) => s.text).join(''))
  return out
}

function codeBlock(text: string): string {
  const lines = text.split('\n')
  const has = (fence: string) => lines.some((l) => l.trimStart().startsWith(fence))
  const fence = !has('```') ? '```' : !has('~~~') ? '~~~' : null
  if (fence) return `${fence}\n${text}\n${fence}`
  // cannot be fenced: plain paragraphs (very rare)
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => escapeLineStart(escapeText(l)))
    .join('\n\n')
}

/** A nested list takes the type of the list it is in: the page renders one type per list block, and
 *  another type would end it (the editor enforces the same, RichTextEditor `SameListType`). */
function listMarkdown(list: RichNode, depth: number, ordered = list.type === 'orderedList'): string[] {
  const marker = ordered ? '1. ' : '- '
  const indent = '  '.repeat(Math.min(depth, MAX_DEPTH))
  const lines: string[] = []
  for (const it of list.content ?? []) {
    const nested = (it.content ?? []).filter((c) => c.type === 'bulletList' || c.type === 'orderedList')
    const text = (it.content ?? [])
      .filter((c) => !nested.includes(c))
      .map((c) => inlineMarkdown(c.type === 'text' ? [c] : c.content).trim())
      .filter(Boolean)
      .join(' ')
    lines.push(indent + marker + text)
    for (const n of nested) lines.push(...listMarkdown(n, depth + 1, ordered))
  }
  return lines
}

function blockMarkdown(n: RichNode): string[] {
  switch (n.type) {
    case 'heading': {
      let text = inlineMarkdown(n.content).trim()
      if (!text) return []
      if (text.endsWith('#') && !text.endsWith('\\#')) text = text.slice(0, -1) + '\\#' // kept, not a closing hash
      return [(n.attrs?.level === 4 ? '### ' : '## ') + escapeLineStart(text)]
    }
    case 'paragraph': {
      const text = inlineMarkdown(n.content).trim()
      return text ? [escapeLineStart(text)] : []
    }
    case 'codeBlock':
      return [codeBlock((n.content ?? []).map((c) => c.text ?? '').join(''))]
    case 'bulletList':
    case 'orderedList':
      return [listMarkdown(n, 0).join('\n')]
    default: // a node this editor does not make: keep its blocks, or its text
      if (n.content?.some((c) => c.type !== 'text' && c.type !== 'hardBreak')) return (n.content ?? []).flatMap(blockMarkdown)
      return blockMarkdown({ type: 'paragraph', content: n.content })
  }
}

export function docToMarkdown(doc: RichNode): string {
  const blocks = (doc.content ?? []).flatMap(blockMarkdown).filter(Boolean)
  return blocks.length ? blocks.join('\n\n') + '\n' : ''
}

/** The Markdown the rich editor writes for a text it was opened with and did not change. */
export function normalizeMarkdown(md: string, opts: MarkdownOptions): string {
  return docToMarkdown(markdownToDoc(md, opts))
}

/** What the editor may open as links: a person's links, never one the AI wrote. When the stored
 *  text is still the AI's (`edited` false) every target in it is blocked, plus the targets the AI
 *  ever wrote (`aiLinks`) — so links a person types in the Markdown mode survive a switch to the
 *  rich editor, and AI links never do (security review H1). */
export function editorOptions(original: string, edited: boolean, aiLinks?: readonly string[]): MarkdownOptions {
  const blocked = new Set(blockedLinkSet(aiLinks))
  if (!edited) {
    for (const b of parseMarkdown(original, { links: true })) {
      const inlines = b.kind === 'list' ? b.items.flatMap((i) => i.inlines) : 'inlines' in b ? b.inlines : []
      for (const i of inlines) if (i.kind === 'link') blocked.add(i.href)
    }
  }
  return { links: true, blocked }
}
