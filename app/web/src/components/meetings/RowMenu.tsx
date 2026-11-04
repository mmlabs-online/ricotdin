// "More actions" disclosure for a meeting row: Escape / outside click close it, focus returns.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Button } from '../ui/Button'

export interface MenuItem {
  key: string
  label: string
  onSelect: () => void
  danger?: boolean
}

export function RowMenu({ label, items }: { label: string; items: MenuItem[] }): ReactNode {
  const [open, setOpen] = useState(false)
  const id = useId()
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    const onFocus = (e: FocusEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onFocus)
    }
  }, [open])

  if (items.length === 0) return <span className="row-menu-spacer" aria-hidden="true" />
  return (
    <div className="row-menu" ref={wrapRef}>
      <Button
        ref={triggerRef}
        variant="ghost"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal size={19} aria-hidden="true" />
      </Button>
      {open && (
        <div className="row-menu-list" id={id}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              className={item.danger ? 'danger' : ''}
              onClick={() => {
                setOpen(false)
                // focus the trigger first: a dialog opened by onSelect returns focus there
                triggerRef.current?.focus()
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
