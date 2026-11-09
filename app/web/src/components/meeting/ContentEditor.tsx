// Edit the summary or the notes (PRO-06). Two modes, remembered per device: rich text (6b, Tiptap,
// loaded only when the editor opens) and Markdown (6a: a text area with a preview through the same
// safe renderer as the panel). Both edit the same Markdown draft. The save carries the hash of the
// text the edit started from, so a change someone made in the meantime is never overwritten
// (409 → reload or keep editing). Opening the rich editor rewrites the text into its own Markdown;
// that alone is not a change (`isDraftChanged`).
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type ComponentType, type FormEvent } from 'react'
import { useBlocker } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useEditContent, type ContentField } from '../../api/meetingDetail'
import { editorOptions, normalizeMarkdown } from '../../lib/editor/richDoc'
import type { MarkdownOptions } from '../../lib/markdown'
import { contentHash, EDITOR_MODE_KEY, editErrorKey, editorMode, isDirty, isDraftChanged, type EditorMode } from '../../lib/meetings/edit'
import { Markdown } from '../Markdown'
import { Button } from '../ui/Button'
import type { default as RichTextEditorView, RichTextHandle } from './RichTextEditor'

type RichProps = ComponentProps<typeof RichTextEditorView> & { onUnavailable: () => void }

/** Rendered instead of the rich editor when its code could not be loaded (offline, new deploy):
 *  tells this editor to use the Markdown mode. The next editor that opens tries the load again. */
function RichUnavailable({ onUnavailable }: RichProps) {
  useEffect(() => onUnavailable(), [onUnavailable])
  return null
}
let richLoadFailed = false
const loadRich = () =>
  lazy<ComponentType<RichProps>>(() =>
    import('./RichTextEditor').catch(() => {
      richLoadFailed = true
      return { default: RichUnavailable }
    }),
  )
let RichLazy = loadRich()
function richComponent() {
  if (richLoadFailed) {
    richLoadFailed = false
    RichLazy = loadRich() // a cached failure would disable the rich mode until a reload
  }
  return RichLazy
}

function storedMode(): EditorMode {
  try {
    return editorMode(localStorage.getItem(EDITOR_MODE_KEY))
  } catch {
    return 'rich'
  }
}
function storeMode(mode: EditorMode) {
  try {
    localStorage.setItem(EDITOR_MODE_KEY, mode)
  } catch {
    // storage blocked: the choice lasts for this editor only
  }
}

export function ContentEditor({
  meetingId,
  field,
  original,
  onClose,
  onDirtyChange,
  links = false,
  aiLinks,
}: {
  meetingId: string
  field: ContentField
  original: string | null
  onClose: (saved: boolean) => void
  onDirtyChange?: (dirty: boolean) => void
  /** how the page renders the stored text: AI text has no links, AI-written targets stay text */
  links?: boolean
  aiLinks?: readonly string[]
}) {
  const { t } = useTranslation()
  const save = useEditContent(meetingId)
  const [RichTextEditor] = useState(richComponent)
  const [base, setBase] = useState(original) // the text this edit started from
  // follows the base: after a conflict it is the latest stored text (maybe a new AI version)
  const mdOptions = useMemo<MarkdownOptions>(() => editorOptions(base ?? '', links, aiLinks), [base, links, aiLinks])
  const [draft, setDraft] = useState(original ?? '')
  const [fromRich, setFromRich] = useState(false) // the draft was last written by the rich editor
  const onRichChange = useCallback((md: string) => {
    setDraft(md)
    setFromRich(true)
  }, [])
  const onUnavailable = useCallback(() => {
    setRichDown(true)
    requestAnimationFrame(() => areaRef.current?.focus())
  }, [])
  const [mode, setMode] = useState<EditorMode>(storedMode)
  const [richKey, setRichKey] = useState(0) // remount the rich editor with the current draft
  const [richDown, setRichDown] = useState(false)
  const [preview, setPreview] = useState(false)
  const [error, setError] = useState<{ key: string; n: number } | null>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const richRef = useRef<RichTextHandle>(null)
  const errId = useId()
  const helpId = useId()
  // = isDraftChanged(base, draft, mdOptions, fromRich), with the base rewritten once, not per key
  const normalizedBase = useMemo(() => normalizeMarkdown(base ?? '', mdOptions), [base, mdOptions])
  const dirty = isDirty(base, draft) && !(fromRich && draft === normalizedBase)
  const busy = save.isPending
  const rich = mode === 'rich' && !richDown

  useEffect(() => {
    // only on mount (the rich editor focuses itself); a mode switch keeps focus on the switch (3.2.2)
    if (mode === 'markdown') areaRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const focusEditor = () => requestAnimationFrame(() => (rich ? richRef.current?.focus() : areaRef.current?.focus()))

  async function submit(e: FormEvent | null, from: string | null = base) {
    e?.preventDefault()
    if (busy) return
    if (!isDraftChanged(from, draft, mdOptions, fromRich)) return onClose(false)
    try {
      await save.mutateAsync({ field, content: draft, baseHash: await contentHash(from) })
      onClose(true)
    } catch (err) {
      setError((prev) => ({ key: editErrorKey(err), n: (prev?.n ?? 0) + 1 }))
      setPreview(false)
      focusEditor()
    }
  }

  function cancel() {
    if (dirty && !window.confirm(t('detail.edit.discardConfirm'))) return
    onClose(false)
  }

  function switchMode(next: EditorMode) {
    if (next === mode) return
    setMode(next)
    storeMode(next)
    setPreview(false)
    if (next === 'rich') setRichKey((k) => k + 1) // open the rich editor on the current draft
  }

  const label = t(`detail.edit.label.${field}`)
  const describedBy = error ? `${helpId} ${errId}` : helpId
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
        {!richDown && (
          <div className="editor-mode" role="group" aria-label={t('detail.edit.mode.label')}>
            <Button aria-pressed={mode === 'rich'} onClick={() => switchMode('rich')}>
              {t('detail.edit.mode.rich')}
            </Button>
            <Button aria-pressed={mode === 'markdown'} onClick={() => switchMode('markdown')}>
              {t('detail.edit.mode.markdown')}
            </Button>
          </div>
        )}
        {!rich && (
          <Button type="button" aria-pressed={preview} onClick={() => setPreview((p) => !p)}>
            {t('detail.edit.preview')}
          </Button>
        )}
        <span id={helpId} className="tab-note">
          {richDown ? t('detail.edit.rich.unavailable') : rich ? t('detail.edit.rich.help') : t('detail.edit.markdownHelp')}
        </span>
      </div>
      {rich ? (
        <Suspense fallback={<p className="tab-note" role="status">{t('detail.edit.rich.loading')}</p>}>
          <RichTextEditor
            key={richKey}
            ref={richRef}
            initial={draft}
            options={mdOptions}
            onChange={onRichChange}
            onUnavailable={onUnavailable}
            label={label}
            describedBy={describedBy}
            invalid={error !== null}
            autoFocus={richKey === 0}
          />
        </Suspense>
      ) : preview ? (
        <div className="content-editor-preview" aria-label={t('detail.edit.previewLabel')} role="region">
          <Markdown source={draft} links aiLinks={aiLinks} />
        </div>
      ) : (
        <label className="content-editor-field">
          <span className="sr-only">{label}</span>
          <textarea
            ref={areaRef}
            value={draft}
            rows={field === 'summary' ? 8 : 18}
            onChange={(e) => {
              setDraft(e.target.value)
              setFromRich(false)
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
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
