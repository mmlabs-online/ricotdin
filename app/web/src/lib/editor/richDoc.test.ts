import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../markdown'
import { docToMarkdown, editorOptions, markdownToDoc as toDoc, normalizeMarkdown as normalize, type RichNode } from './richDoc'

// A person's text (links allowed); the AI's text and blocked targets are tested below.
const LINKS = { links: true }
const markdownToDoc = (md: string) => toDoc(md, LINKS)
const normalizeMarkdown = (md: string) => normalize(md, LINKS)

const p = (...content: RichNode[]): RichNode => ({ type: 'paragraph', content })
const txt = (text: string, ...marks: RichNode['marks'] & object): RichNode =>
  marks.length ? { type: 'text', text, marks } : { type: 'text', text }
const doc = (...content: RichNode[]): RichNode => ({ type: 'doc', content })
const item = (...content: RichNode[]): RichNode => ({ type: 'listItem', content })
const bold = { type: 'bold' }
const italic = { type: 'italic' }
const code = { type: 'code' }
const link = (href: string) => ({ type: 'link', attrs: { href } })

/** What the meeting page shows for a text: the editor must never change it by itself. */
const shown = (md: string) => parseMarkdown(md, { links: true })

const AI_NOTES = `## Decisions
- Ship **v2** on *Friday* after the \`smoke\` check
- Move the retro to [the board](https://board.example/r)
  - nested point
    - deeper point
1. First step
2) Second step

### Open questions
Who owns the C# client? Budget is ~5k (approx.) and file_name_here stays.
A second line of the same paragraph.

\`\`\`
SELECT 1;
\`\`\`

---
> quoted line
![diagram](https://img.example/d.png) and ~~old~~ text
# Big heading ##
`

describe('markdownToDoc (PRO-06 6b)', () => {
  it('maps the blocks the page renders to editor nodes', () => {
    expect(markdownToDoc('## Title\n\nHello **you** and *me* `x` [d](https://a.test/p)')).toEqual(
      doc(
        { type: 'heading', attrs: { level: 3 }, content: [txt('Title')] },
        p(txt('Hello '), txt('you', bold), txt(' and '), txt('me', italic), txt(' '), txt('x', code), txt(' '), txt('d', link('https://a.test/p'))),
      ),
    )
  })

  it('keeps headings at the level they are shown (h3 / h4)', () => {
    const levels = (markdownToDoc('# a\n\n## b\n\n### c\n\n#### d').content ?? []).map((n) => n.attrs?.level)
    expect(levels).toEqual([3, 3, 4, 4])
  })

  it('nests flat list items by depth', () => {
    expect(markdownToDoc('- a\n  - b\n    - c\n- d')).toEqual(
      doc({
        type: 'bulletList',
        content: [
          item(p(txt('a')), { type: 'bulletList', content: [item(p(txt('b')), { type: 'bulletList', content: [item(p(txt('c')))] })] }),
          item(p(txt('d'))),
        ],
      }),
    )
  })

  it('never starts a list deeper than its first item', () => {
    expect(markdownToDoc('    - deep first\n- top')).toEqual(doc({ type: 'bulletList', content: [item(p(txt('deep first'))), item(p(txt('top')))] }))
  })

  it('turns code fences into code blocks and an empty text into one empty paragraph', () => {
    expect(markdownToDoc('```\na\n  b\n```')).toEqual(doc({ type: 'codeBlock', content: [txt('a\n  b')] }))
    expect(markdownToDoc('')).toEqual(doc({ type: 'paragraph' }))
    expect(markdownToDoc('```\n```')).toEqual(doc({ type: 'codeBlock' }))
  })

  it('keeps only https links; other links and images become their text', () => {
    expect(markdownToDoc('[a](javascript:alert%281%29) [b](http://x.test) ![c](https://i.test/p.png)')).toEqual(doc(p(txt('a b c'))))
  })
})

describe('docToMarkdown (PRO-06 6b)', () => {
  it('writes the safe set', () => {
    expect(
      docToMarkdown(
        doc(
          { type: 'heading', attrs: { level: 3 }, content: [txt('Title')] },
          { type: 'heading', attrs: { level: 4 }, content: [txt('Sub')] },
          p(txt('a '), txt('b', bold), txt(' '), txt('c', italic), txt(' '), txt('d', code), txt(' '), txt('e', link('https://a.test/'))),
          { type: 'orderedList', attrs: { start: 1 }, content: [item(p(txt('one'))), item(p(txt('two')))] },
          { type: 'codeBlock', attrs: { language: null }, content: [txt('x = 1')] },
        ),
      ),
    ).toBe('## Title\n\n### Sub\n\na **b** *c* `d` [e](https://a.test/)\n\n1. one\n1. two\n\n```\nx = 1\n```\n')
  })

  it('escapes text so it is never read as formatting', () => {
    const md = docToMarkdown(doc(p(txt('2*3*4 and **not bold** and `tick` and [x](https://a.test) and back\\slash'))))
    expect(shown(md)).toEqual([{ kind: 'paragraph', inlines: [{ kind: 'text', text: '2*3*4 and **not bold** and `tick` and [x](https://a.test) and back\\slash' }] }])
  })

  it('escapes what would start a block at the start of a paragraph', () => {
    for (const line of ['# not a heading', '- not a list', '+ not a list', '1. not a list', '7) not a list', '> not a quote', '---', '___', '```', '~~~ not a fence']) {
      expect(shown(docToMarkdown(doc(p(txt(line)))))).toEqual([{ kind: 'paragraph', inlines: [{ kind: 'text', text: line }] }])
    }
  })

  it('leaves ordinary punctuation alone', () => {
    expect(docToMarkdown(doc(p(txt('snake_case, ~5 min, C# and 3.5 - fine (ok) [todo] #12'))))).toBe(
      'snake_case, \\~5 min, C# and 3.5 - fine (ok) \\[todo] #12\n',
    )
  })

  it('keeps a trailing # in a heading', () => {
    const md = docToMarkdown(doc({ type: 'heading', attrs: { level: 3 }, content: [txt('Issue ##')] }))
    expect(shown(md)).toEqual([{ kind: 'heading', level: 3, inlines: [{ kind: 'text', text: 'Issue ##' }] }])
  })

  it('moves spaces out of a mark and drops a mark it cannot write', () => {
    expect(docToMarkdown(doc(p(txt('a'), txt(' b ', bold), txt('c'))))).toBe('a **b** c\n')
    expect(docToMarkdown(doc(p(txt('a'), txt(' ', bold), txt('c'))))).toBe('a c\n')
    expect(docToMarkdown(doc(p(txt('x', code), txt('a`b', code))))).toBe('`x`a\\`b\n')
    // `*a*b` is not italic on the page: the word right after needs `_`, and `_a_b` fails too
    expect(docToMarkdown(doc(p(txt('a', italic), txt('b'))))).toBe('ab\n')
    expect(docToMarkdown(doc(p(txt('x '), txt('a*b', italic), txt('.'))))).toBe('x _a*b_.\n')
  })

  it('writes a link only for a safe https target, as text otherwise', () => {
    expect(docToMarkdown(doc(p(txt('a', link('javascript:alert(1)')))))).toBe('a\n')
    expect(docToMarkdown(doc(p(txt('a', link('https://u:p@a.test/')))))).toBe('a\n')
    expect(docToMarkdown(doc(p(txt('a]b', link('https://a.test/')))))).toBe('a]b\n')
  })

  it('writes nested lists with two spaces per level', () => {
    const md = docToMarkdown(
      doc({ type: 'bulletList', content: [item(p(txt('a')), { type: 'orderedList', content: [item(p(txt('b')))] }), item(p(txt('c')))] }),
    )
    expect(md).toBe('- a\n  - b\n- c\n')
  })

  it('separates two lists so they stay two lists', () => {
    const md = docToMarkdown(doc({ type: 'bulletList', content: [item(p(txt('a')))] }, { type: 'bulletList', content: [item(p(txt('b')))] }))
    expect(shown(md)).toHaveLength(2)
  })

  it('picks a fence the code does not contain', () => {
    expect(docToMarkdown(doc({ type: 'codeBlock', content: [txt('```\nx')] }))).toBe('~~~\n```\nx\n~~~\n')
    const both = docToMarkdown(doc({ type: 'codeBlock', content: [txt('```\n~~~')] }))
    expect(shown(both)).toEqual([
      { kind: 'paragraph', inlines: [{ kind: 'text', text: '```' }] },
      { kind: 'paragraph', inlines: [{ kind: 'text', text: '~~~' }] },
    ])
  })

  it('skips empty paragraphs and reads unknown nodes as their text', () => {
    expect(docToMarkdown(doc(p(), p(txt('a')), { type: 'blockquote', content: [p(txt('q'))] }))).toBe('a\n\nq\n')
    expect(docToMarkdown(doc(p()))).toBe('')
  })

  it('turns a line break inside a paragraph into a space', () => {
    expect(docToMarkdown(doc(p(txt('a\nb'))))).toBe('a b\n')
  })
})

describe('round trip (PRO-06 6b): opening the editor never changes what the page shows', () => {
  it('keeps the rendering of typical AI notes', () => {
    expect(shown(normalizeMarkdown(AI_NOTES))).toEqual(shown(AI_NOTES))
  })

  it('is stable after the first pass', () => {
    const once = normalizeMarkdown(AI_NOTES)
    expect(normalizeMarkdown(once)).toBe(once)
  })

  it('keeps tricky inline text', () => {
    for (const md of ['a **b*c** d', '*a* **b** `c`', 'x __y__ z', 'see [a b](https://a.test/x?y=1&z=2)', 'C:\\temp\\x', 'price $5 * 2']) {
      expect(shown(normalizeMarkdown(md))).toEqual(shown(md))
    }
  })

  it('keeps a document built in the editor', () => {
    const built = doc(
      { type: 'heading', attrs: { level: 4 }, content: [txt('Plan *v2*')] },
      p(txt('Use '), txt('a_b', italic), txt(' then '), txt('**', bold), txt(' and '), txt('[x]', code)),
    )
    expect(markdownToDoc(docToMarkdown(built))).toEqual(built)
  })
})

describe('review fixes (PRO-06 6b)', () => {
  it('uses the parser’s ASCII word rule next to Vietnamese letters', () => {
    for (const md of ['mã\\_số\\_điện', 'é*x*é']) expect(shown(normalizeMarkdown(md))).toEqual(shown(md))
    expect(shown(docToMarkdown(doc(p(txt('mã_số_điện')))))).toEqual([{ kind: 'paragraph', inlines: [{ kind: 'text', text: 'mã_số_điện' }] }])
    expect(shown(docToMarkdown(doc(p(txt('x', italic), txt('é')))))).toEqual(shown('*x*é'))
  })

  it('keeps a ! right before a link', () => {
    const md = docToMarkdown(doc(p(txt('Click!'), txt('docs', link('https://a.test/')))))
    expect(shown(md)).toEqual([
      { kind: 'paragraph', inlines: [{ kind: 'text', text: 'Click!' }, { kind: 'link', text: 'docs', href: 'https://a.test/', host: 'a.test' }] },
    ])
  })

  it('writes a nested list with the type of the list it is in (the page nests one type)', () => {
    const md = docToMarkdown(
      doc({ type: 'bulletList', content: [item(p(txt('a')), { type: 'orderedList', content: [item(p(txt('b')))] }), item(p(txt('c')))] }),
    )
    expect(md).toBe('- a\n  - b\n- c\n')
    expect(shown(md)).toHaveLength(1)
  })

  it('opens the AI’s links and blocked targets as text, never as links (security review H1)', () => {
    const ai = 'Pay [the invoice](https://evil.example/a(b) now'
    expect(JSON.stringify(toDoc(ai, { links: false }))).not.toContain('"link"')
    const blocked = new Set(['https://evil.example/x'])
    expect(JSON.stringify(toDoc('[x](https://evil.example/x)', { links: true, blocked }))).not.toContain('"link"')
    expect(shown(normalize(ai, { links: false }))).toEqual(parseMarkdown(ai))
  })

  it('never writes a link target with parentheses (it would escape the blocked set)', () => {
    expect(docToMarkdown(doc(p(txt('a', link('https://a.test/x(1)')))))).toBe('a\n')
  })

  it('escapes ~ everywhere, so two pieces never join into ~~ (security review M2)', () => {
    const md = docToMarkdown(doc(p(txt('q~'), txt('~y '), txt('~~[x](https://evil.example)', code))))
    expect(shown(md).flatMap((b) => ('inlines' in b ? b.inlines : [])).some((i) => i.kind === 'link')).toBe(false)
  })

  it('never writes a link that was not a link in the editor (property test)', () => {
    const pieces = ['a', ' ', '~', '*', '_', '`', '[', ']', '(', ')', '!', '\\', 'https://e.test/', 'é', '#', '1.', '-']
    const marks = [[], [bold], [italic], [code], [link('https://ok.test/')]] as RichNode['marks'][]
    let seed = 7
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    for (let run = 0; run < 2000; run++) {
      const content: RichNode[] = []
      for (let i = 0, n = 1 + rnd(6); i < n; i++) {
        let text = ''
        for (let j = 0, m = 1 + rnd(5); j < m; j++) text += pieces[rnd(pieces.length)]
        const mk = marks[rnd(marks.length)]
        content.push(mk && mk.length ? { type: 'text', text, marks: mk } : { type: 'text', text })
      }
      const hrefs = shown(docToMarkdown(doc(p(...content))))
        .flatMap((b) => ('inlines' in b ? b.inlines : []))
        .flatMap((i) => (i.kind === 'link' ? [i.href] : []))
      for (const h of hrefs) expect(h).toBe('https://ok.test/')
      const wanted = content.filter((c) => c.marks?.some((m) => m.type === 'link')).length
      expect(hrefs.length).toBeLessThanOrEqual(wanted)
    }
  })
})
describe('editorOptions (security review H1)', () => {
  const ai = '- see [the board](https://evil.example/b)\n\nand [docs](https://evil.example/d)'
  it('blocks every link of a text the AI wrote, but keeps links a person adds', () => {
    const opts = editorOptions(ai, false)
    expect(JSON.stringify(toDoc(ai, opts))).not.toContain('"link"')
    expect(JSON.stringify(toDoc(ai + '\n\n[mine](https://ok.test/)', opts))).toContain('https://ok.test/')
  })
  it('allows a person’s links in an edited text, except the AI’s targets', () => {
    const opts = editorOptions('[x](https://ok.test/) [y](https://evil.example/y)', true, ['https:evil.example/y'])
    const json = JSON.stringify(toDoc('[x](https://ok.test/) [y](https://evil.example/y)', opts))
    expect(json).toContain('https://ok.test/')
    expect(json).not.toContain('evil.example')
  })
})
