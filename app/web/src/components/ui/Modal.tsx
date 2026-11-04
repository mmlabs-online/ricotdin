// Accessible dialog (pattern from v1 RecordingNoticeModal, COM-01): portal into <body>, the rest of
// the page `inert`, focus on the heading (never on the confirm button, so a stray Enter cannot
// confirm unread text), Tab trapped, Escape / backdrop cancel, focus returned to the opener.
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './Button'

export function Modal({
  title,
  onClose,
  describedBy,
  children,
}: {
  title: string
  onClose: () => void
  describedBy?: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overlay = dialogRef.current?.parentElement ?? null
    const madeInert: HTMLElement[] = []
    for (const el of Array.from(document.body.children)) {
      if (el instanceof HTMLElement && el !== overlay && !el.inert) {
        el.inert = true
        madeInert.push(el)
      }
    }
    headingRef.current?.focus()

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      )
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      const active = document.activeElement
      const inside = active instanceof Node && dialogRef.current.contains(active)
      if (e.shiftKey && (active === first || !inside || active === headingRef.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      for (const el of madeInert) el.inert = false
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={() => onCloseRef.current()}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id={titleId} ref={headingRef} tabIndex={-1}>
            {title}
          </h2>
          <Button variant="ghost" onClick={onClose} aria-label={t('common.close')}>
            <X size={18} aria-hidden="true" />
          </Button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}
