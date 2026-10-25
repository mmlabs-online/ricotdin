'use client'

// COM-01 — notice shown before a recording starts. The user must acknowledge it to proceed.
//
// Accessibility: focus moves to the heading (not the confirm button, so a stray Enter can't
// acknowledge a notice nobody read), Tab is trapped inside the dialog, Escape / backdrop
// cancel, and focus returns to the element that opened the dialog when it closes.
// Rendered through a portal into <body> (a transformed ancestor would break `fixed`), with
// the rest of the page made `inert` while it is open.

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { RECORDING_NOTICE_TEXT, VERBAL_NOTICE_SCRIPT } from '@/lib/consent/recordingNotice'

export default function RecordingNoticeModal({
  onAcknowledge,
  onCancel,
}: {
  onAcknowledge: () => void
  onCancel: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  // Latest onCancel without re-running the mount effect (the parent passes a new function each render).
  const onCancelRef = useRef(onCancel)
  useEffect(() => { onCancelRef.current = onCancel }, [onCancel])

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Make everything outside the portal inert (not focusable, hidden from assistive tech).
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
        onCancelRef.current()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-b-fg/40 p-4"
      onClick={() => onCancelRef.current()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="recording-notice-title"
        aria-describedby="recording-notice-body recording-notice-script"
        className="bg-white rounded-3xl border border-b-border shadow-b-xl p-6 sm:p-8 w-full max-w-md max-h-[90vh] overflow-y-auto flex flex-col gap-4 motion-reduce:transition-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="recording-notice-title"
          ref={headingRef}
          tabIndex={-1}
          className="font-serif text-xl font-bold text-b-fg outline-none"
        >
          Before you record
        </h2>
        <p id="recording-notice-body" className="text-sm text-b-fg/80 font-sans leading-relaxed">
          {RECORDING_NOTICE_TEXT}
        </p>
        <div className="bg-b-clay border border-b-border rounded-2xl px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-b-fg/80 font-sans mb-1">Suggested opening</p>
          <p id="recording-notice-script" className="text-sm text-b-fg/80 font-sans italic leading-relaxed">&ldquo;{VERBAL_NOTICE_SCRIPT}&rdquo;</p>
        </div>
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button type="button" className="btn-secondary w-full sm:w-auto" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn-primary w-full sm:w-auto" onClick={onAcknowledge}>
            I understand — start recording
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
