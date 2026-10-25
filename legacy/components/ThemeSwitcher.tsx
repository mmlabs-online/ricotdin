'use client'

import { useState } from 'react'
import { useTheme } from '@/hooks/useTheme'
import { THEMES, type Theme } from '@/lib/theme'

export default function ThemeSwitcher() {
  const { theme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)

  const active = THEMES.find((t) => t.id === theme) ?? THEMES[0]

  return (
    <div className="relative">
      {/* Trigger button — shows current theme swatch */}
      <button
        onClick={() => setOpen((v) => !v)}
        title="Switch theme"
        aria-label={`Current theme: ${active.label}. Click to switch.`}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border transition-all duration-300 cursor-pointer bg-transparent"
        style={{ borderColor: 'rgb(var(--t-border-rgb))' }}
      >
        <Swatch theme={active} size={14} />
        <span
          className="text-xs font-semibold uppercase tracking-widest hidden sm:block"
          style={{ color: 'rgb(var(--t-fg-rgb) / 0.6)', fontFamily: 'var(--t-font-body)' }}
        >
          {active.label}
        </span>
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none"
          className="transition-transform duration-200"
          style={{
            color: 'rgb(var(--t-fg-rgb) / 0.4)',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        >
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Dropdown panel */}
      {open && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div
            className="absolute right-0 top-full mt-2 z-50 p-2 flex flex-col gap-1"
            style={{
              background: 'rgb(var(--t-bg-rgb))',
              border: '1px solid rgb(var(--t-border-rgb))',
              borderRadius: '1rem',
              boxShadow: 'var(--t-shadow-xl)',
              minWidth: 180,
            }}
          >
            {THEMES.map((t) => (
              <ThemeOption
                key={t.id}
                t={t}
                active={theme === t.id}
                onSelect={(id) => { setTheme(id); setOpen(false) }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function ThemeOption({
  t,
  active,
  onSelect,
}: {
  t: typeof THEMES[number]
  active: boolean
  onSelect: (id: Theme) => void
}) {
  return (
    <button
      onClick={() => onSelect(t.id)}
      className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-left cursor-pointer border-0 transition-all duration-200"
      style={{
        background: active ? 'rgb(var(--t-clay-rgb))' : 'transparent',
        fontFamily: 'var(--t-font-body)',
      }}
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'rgb(var(--t-clay-rgb) / 0.6)'
      }}
      onMouseLeave={(e) => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
      }}
    >
      <Swatch theme={t} size={28} ring={active} />
      <div className="flex-1 min-w-0">
        <div
          className="text-sm font-semibold leading-tight"
          style={{ color: 'rgb(var(--t-fg-rgb))' }}
        >
          {t.label}
        </div>
        <div
          className="text-xs leading-tight mt-0.5"
          style={{ color: 'rgb(var(--t-fg-rgb) / 0.45)', fontFamily: 'var(--t-font-body)' }}
        >
          {t.tagline}
        </div>
      </div>
      {active && (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ color: 'rgb(var(--t-primary-rgb))', flexShrink: 0 }}>
          <path d="M2 7L5.5 10.5L12 4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  )
}

function Swatch({
  theme,
  size,
  ring = false,
}: {
  theme: typeof THEMES[number]
  size: number
  ring?: boolean
}) {
  const style: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: theme.id === 'playful'
      ? '60% 40% 70% 30% / 40% 60% 30% 70%'
      : '50%',
    background: `linear-gradient(135deg, ${theme.swatch1}, ${theme.swatch2})`,
    flexShrink: 0,
    outline: ring ? `2px solid rgb(var(--t-primary-rgb))` : 'none',
    outlineOffset: 2,
  }
  return <span style={style} aria-hidden="true" />
}
