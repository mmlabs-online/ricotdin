// Edit the summary or the notes (PRO-06, part 6a): a Markdown text area with a preview through the
// same safe renderer as the panel. The save carries the hash of the text the edit started from,
// so a change someone made in the meantime is never overwritten (409 → reload or keep editing).
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useBlocker } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useEditContent, type ContentField } from '../../api/meetingDetail'
import { contentHash, editErrorKey, isDirty } from '../../lib/meetings/edit'
import { Markdown } from '../Markdown'
import { Button } from '../ui/Button'

export function ContentEditor({
  meetingId,
  field,
  original,
  onClose,
  onDirtyChange,
}: {
  meetingId: string
  field: ContentField
  original: string | null
  onClose: (saved: boolean) => void
  onDirtyChange?: (dirty: boolean) => void
}) {
  const { t } = useTranslation()
  const save = useEditContent(meetingId)
  const [base, setBase] = useState(original) // the text this edit started from
  const [draft, setDraft] = useState(original ?? '')
  const [preview, setPreview] = useState(false)
  const [error, setError] = useState<{ key: string; n: number } | null>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const errId = useId()
  const helpId = useId()
  const dirty = isDirty(base, draft)
  const busy = save.isPending

  useEffect(() => {
    areaRef.current?.focus()
  }, [])
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
  // After a conflict the page reloads the text (`original`); "Use the latest text" makes it the
  // new base and keeps the draft, so the next save is checked against what is stored now.
  const conflict = error?.key === 'detail.edit.errors.changed'
  const latestDiffers = conflict && (original ?? '') !== (base ?? '')

  // Leaving with unsaved text asks first (in-app navigation and reload).
  const blocker = useBlocker(dirty && !busy)
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    if (window.confirm(t('detail.edit.leaveConfirm'))) blocker.proceed()
    else blocker.reset()
  }, [blocker, t])
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = '' // older Chromium / Safari
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  async function submit(e: FormEvent | null, from: string | null = base) {
    e?.preventDefault()
    if (busy) return
    if (!isDirty(from, draft)) return onClose(false)
    try {
      await save.mutateAsync({ field, content: draft, baseHash: await contentHash(from) })
      onClose(true)
    } catch (err) {
      setError((prev) => ({ key: editErrorKey(err), n: (prev?.n ?? 0) + 1 }))
      setPreview(false)
      requestAnimationFrame(() => areaRef.current?.focus())
    }
  }

  function cancel() {
    if (dirty && !window.confirm(t('detail.edit.discardConfirm'))) return
    onClose(false)
  }

  const label = t(`detail.edit.label.${field}`)
  return (
    <form
      className="content-editor"
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        }
      }}
      noValidate
    >
      <div className="content-editor-bar">
        <Button type="button" aria-pressed={preview} onClick={() => setPreview((p) => !p)}>
          {t('detail.edit.preview')}
        </Button>
        <span id={helpId} className="tab-note">
          {t('detail.edit.markdownHelp')}
        </span>
      </div>
      {preview ? (
        <div className="content-editor-preview" aria-label={t('detail.edit.previewLabel')} role="region">
          <Markdown source={draft} links />
        </div>
      ) : (
        <label className="content-editor-field">
          <span className="sr-only">{label}</span>
          <textarea
            ref={areaRef}
            value={draft}
            rows={field === 'summary' ? 8 : 18}
            onChange={(e) => setDraft(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${helpId} ${errId}` : helpId}
          />
        </label>
      )}
      {error && (
        <p id={errId} key={error.n} className="auth-error" role="alert">
          {t(error.key)}
        </p>
      )}
      {latestDiffers && (
        <div className="content-editor-latest">
          <p className="tab-note">{t('detail.edit.latestHelp')}</p>
          <Markdown source={original ?? ''} />
          <Button
            type="button"
            onClick={() => {
              setBase(original) // the draft now replaces the latest text, checked against it
              void submit(null, original)
            }}
          >
            {t('detail.edit.useLatest')}
          </Button>
        </div>
      )}
      <div className="panel-footer">
        <Button type="submit" variant="primary" aria-disabled={busy || undefined} aria-busy={busy}>
          {busy ? t('detail.edit.saving') : t('detail.edit.save')}
        </Button>
        <Button type="button" onClick={cancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  )
}
