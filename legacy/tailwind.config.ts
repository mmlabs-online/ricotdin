import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      // Colors backed by CSS variables so all 3 themes just swap the vars.
      // The `rgb(var(...) / <alpha-value>)` syntax enables opacity modifiers
      // like bg-b-fg/60 to work correctly across all themes.
      colors: {
        'b-bg':        'rgb(var(--t-bg-rgb)       / <alpha-value>)',
        'b-fg':        'rgb(var(--t-fg-rgb)        / <alpha-value>)',
        'b-primary':   'rgb(var(--t-primary-rgb)   / <alpha-value>)',
        'b-secondary': 'rgb(var(--t-secondary-rgb) / <alpha-value>)',
        'b-border':    'rgb(var(--t-border-rgb)    / <alpha-value>)',
        'b-terra':     'rgb(var(--t-terra-rgb)     / <alpha-value>)',
        'b-clay':      'rgb(var(--t-clay-rgb)      / <alpha-value>)',
      },
      // Font families also use CSS variables so the active theme's fonts load automatically.
      fontFamily: {
        serif: ['var(--t-font-heading)'],
        sans:  ['var(--t-font-body)'],
      },
      boxShadow: {
        'b-sm':  'var(--t-shadow-sm)',
        'b-md':  'var(--t-shadow-md)',
        'b-xl':  'var(--t-shadow-xl)',
      },
    },
  },
  plugins: [],
}

export default config
