// ARC-11: user-facing JSX attributes must come from the i18n files, never literal text.
// (oxlint's react/jsx-no-literals covers JSX children; it cannot single out these props.)
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ATTRS = ['placeholder', 'title', 'alt', 'label', 'aria-label', 'aria-description', 'aria-placeholder', 'aria-valuetext']
const pattern = new RegExp(`\\b(${ATTRS.join('|')})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*["'\`]([^"'\`]*)["'\`]\\s*\\})`, 'g')

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* files(path)
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) yield path
  }
}

let problems = 0
for (const file of files('src')) {
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(pattern)) {
      const text = m[2] ?? m[3] ?? m[4] ?? ''
      if (/\p{L}/u.test(text)) {
        problems += 1
        console.log(`${file}:${i + 1}: ${m[1]}="${text}" — move this text to src/i18n/locales/*.json`)
      }
    }
  })
}
if (problems) {
  console.log(`\n${problems} hard-coded user-facing attribute(s).`)
  process.exit(1)
}
console.log('i18n attribute check: ok')
