import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown, safeLinkHref } from './markdown'

describe('parseInline', () => {
  it('keeps plain text', () => {
    expect(parseInline('hello world')).toEqual([{ kind: 'text', text: 'hello world' }])
  })

  it('reads bold, italic and code', () => {
    expect(parseInline('a **b** *c* `d` __e__')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', text: 'b' },
      { kind: 'text', text: ' ' },
      { kind: 'em', text: 'c' },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'd' },
      { kind: 'text', text: ' ' },
      { kind: 'strong', text: 'e' },
    ])
  })

  it('turns links and images into their text only (no remote fetch, no navigation)', () => {
    expect(parseInline('see [the doc](https://evil.example/x?d=1) ![leak](https://evil.example/p.png)')).toEqual([
      { kind: 'text', text: 'see the doc leak' },
    ])
  })

  it('keeps html as text', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([{ kind: 'text', text: '<img src=x onerror=alert(1)>' }])
  })

  it('leaves unmatched markers and snake_case alone', () => {
    expect(parseInline('a * b and file_name_here **open')).toEqual([{ kind: 'text', text: 'a * b and file_name_here **open' }])
  })

  it('drops strikethrough markers', () => {
    expect(parseInline('~~old~~ new')).toEqual([{ kind: 'text', text: 'old new' }])
  })
})

describe('parseMarkdown', () => {
  it('returns nothing for empty input', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('  \n\n ')).toEqual([])
  })

  it('reads headings (one level below the page sections)', () => {
    expect(parseMarkdown('# A\n## B\n### C\n#### D')).toEqual([
      { kind: 'heading', level: 3, inlines: [{ kind: 'text', text: 'A' }] },
      { kind: 'heading', level: 3, inlines: [{ kind: 'text', text: 'B' }] },
      { kind: 'heading', level: 4, inlines: [{ kind: 'text', text: 'C' }] },
      { kind: 'heading', level: 4, inlines: [{ kind: 'text', text: 'D' }] },
    ])
  })

  it('joins paragraph lines and splits on blank lines', () => {
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([
      { kind: 'paragraph', inlines: [{ kind: 'text', text: 'one two' }] },
      { kind: 'paragraph', inlines: [{ kind: 'text', text: 'three' }] },
    ])
  })

  it('reads bullet and numbered lists with nesting', () => {
    expect(parseMarkdown('- a\n  - b\n* c\n\n1. x\n2) y')).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [
          { depth: 0, inlines: [{ kind: 'text', text: 'a' }] },
          { depth: 1, inlines: [{ kind: 'text', text: 'b' }] },
          { depth: 0, inlines: [{ kind: 'text', text: 'c' }] },
        ],
      },
      {
        kind: 'list',
        ordered: true,
        items: [
          { depth: 0, inlines: [{ kind: 'text', text: 'x' }] },
          { depth: 0, inlines: [{ kind: 'text', text: 'y' }] },
        ],
      },
    ])
  })

  it('caps nesting depth', () => {
    const [list] = parseMarkdown('- a\n          - deep')
    expect(list).toMatchObject({ kind: 'list', items: [{ depth: 0 }, { depth: 2 }] })
  })

  it('starts a new list when the kind changes', () => {
    expect(parseMarkdown('- a\n1. b').map((b) => b.kind)).toEqual(['list', 'list'])
  })

  it('a heading right after a list ends it', () => {
    expect(parseMarkdown('- a\n## Next\ntext').map((b) => b.kind)).toEqual(['list', 'heading', 'paragraph'])
  })

  it('keeps fenced code as text', () => {
    expect(parseMarkdown('```js\nconst a = 1\n**not bold**\n```\nafter')).toEqual([
      { kind: 'code', text: 'const a = 1\n**not bold**' },
      { kind: 'paragraph', inlines: [{ kind: 'text', text: 'after' }] },
    ])
  })

  it('an unclosed fence runs to the end', () => {
    expect(parseMarkdown('```\nx')).toEqual([{ kind: 'code', text: 'x' }])
  })

  it('ignores horizontal rules and handles CRLF', () => {
    expect(parseMarkdown('a\r\n---\r\nb')).toEqual([
      { kind: 'paragraph', inlines: [{ kind: 'text', text: 'a' }] },
      { kind: 'paragraph', inlines: [{ kind: 'text', text: 'b' }] },
    ])
  })

  it('reads a block quote as a paragraph', () => {
    expect(parseMarkdown('> quoted')).toEqual([{ kind: 'paragraph', inlines: [{ kind: 'text', text: 'quoted' }] }])
  })

  it('bounds very long input', () => {
    const blocks = parseMarkdown('x'.repeat(300_000))
    const first = blocks[0]
    expect(first?.kind === 'paragraph' && first.inlines[0]?.text.length).toBe(20_000)
  })

  it('stays fast on hostile text (stray markers)', () => {
    for (const unit of ['** ', '__a ', '~~a ', '[a ', '*a ', '`a ', '![a](']) {
      const started = performance.now()
      parseMarkdown(unit.repeat(60_000))
      expect(performance.now() - started).toBeLessThan(1000)
    }
  })

  it('stays fast on hostile lines (whitespace runs in headings, rules, lists)', () => {
    const lines = [
      '# a' + ' '.repeat(20_000) + 'b',
      '#' + ' '.repeat(20_000) + '#'.repeat(5) + ' x',
      '-' + ' -'.repeat(20_000) + ' x',
      ' '.repeat(20_000) + '- x',
      '1.' + ' '.repeat(20_000) + 'x',
      '>' + ' '.repeat(20_000) + 'x',
    ]
    for (const line of lines) {
      const started = performance.now()
      parseMarkdown(line)
      expect(performance.now() - started).toBeLessThan(200)
    }
  })

  it('a full-size note of stray markers stays fast', () => {
    const started = performance.now()
    parseMarkdown(('**a [b]( ~~c ' + '#'.repeat(3) + '\n').repeat(15_000))
    expect(performance.now() - started).toBeLessThan(1500)
  })

  it('strips closing hashes from headings', () => {
    expect(parseMarkdown('## Title ##')).toEqual([{ kind: 'heading', level: 3, inlines: [{ kind: 'text', text: 'Title' }] }])
  })

  it('a link with a space in its target stays text with its brackets', () => {
    expect(parseInline('[a](b c)')).toEqual([{ kind: 'text', text: '[a](b c)' }])
  })
})

describe('links in summary / notes (PRO-06)', () => {
  it('keeps only https links, with their host, when links are allowed', () => {
    expect(parseInline('see [the doc](https://docs.example.com/a?b=1) now', { links: true })).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'the doc', href: 'https://docs.example.com/a?b=1', host: 'docs.example.com' },
      { kind: 'text', text: ' now' },
    ])
  })

  it('never links other schemes, credentials or images', () => {
    for (const src of ['[x](javascript:void0)', '[x](http://a.test)', '[x](data:text/html,hi)', '[x](https://u:p@a.test)', '[x](//a.test)']) {
      expect(parseInline(src, { links: true })).toEqual([{ kind: 'text', text: 'x' }])
    }
    expect(parseInline('![pic](https://a.test/p.png)', { links: true })).toEqual([{ kind: 'text', text: 'pic' }])
  })

  it('chat and every other caller keep links as text (default)', () => {
    expect(parseInline('[x](https://a.test)')).toEqual([{ kind: 'text', text: 'x' }])
    expect(parseMarkdown('[x](https://a.test)')).toEqual([{ kind: 'paragraph', inlines: [{ kind: 'text', text: 'x' }] }])
  })

  it('passes the option through blocks', () => {
    const [p] = parseMarkdown('- [x](https://a.test)', { links: true })
    expect(p).toMatchObject({ kind: 'list', items: [{ inlines: [{ kind: 'link', host: 'a.test' }] }] })
  })

  it('safeLinkHref accepts https only and normalises', () => {
    expect(safeLinkHref('https://A.test/x')).toBe('https://a.test/x')
    expect(safeLinkHref('HTTPS://a.test')).toBe('https://a.test/')
    expect(safeLinkHref('ftp://a.test')).toBeNull()
    expect(safeLinkHref('not a url')).toBeNull()
  })
})
