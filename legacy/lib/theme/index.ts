export type Theme = 'luxury' | 'default' | 'playful'

export const THEMES: {
  id: Theme
  label: string
  tagline: string
  /** CSS color stop 1 for the swatch gradient */
  swatch1: string
  /** CSS color stop 2 for the swatch gradient */
  swatch2: string
}[] = [
  {
    id: 'luxury',
    label: 'Botanical',
    tagline: 'Organic · Warm · Serif',
    swatch1: '#8C9A84',
    swatch2: '#C27B66',
  },
  {
    id: 'default',
    label: 'Corporate',
    tagline: 'Clean · Bold · Modern',
    swatch1: '#4F46E5',
    swatch2: '#7C3AED',
  },
  {
    id: 'playful',
    label: 'Playful',
    tagline: 'Sketchy · Fun · Human',
    swatch1: '#ff4d4d',
    swatch2: '#2d5da1',
  },
]

export const DEFAULT_THEME: Theme = 'luxury'
export const STORAGE_KEY = 'ricotdin-theme'
