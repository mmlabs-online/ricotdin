import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { App } from './App'

// ARC-00: proves the vitest path (CLAUDE.md §0) works; replaced with real tests in ARC-11.
describe('App placeholder', () => {
  it('renders the v2 heading', () => {
    expect(renderToString(<App />)).toContain('Ricotdin v2')
  })
})
