// Speaker names (PRO-04): one name field per transcript label for the owner / editors (with names
// used before as suggestions), the names as text for viewers. Saving updates the transcript at once.
// Rendered inside the transcript section, under its heading (TranscriptPanel `speakers` slot).
import { useId, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useSpeakerNames, useSpeakerSuggestions } from '../../api/meetingDetail'
import { MAX_SPEAKER_NAME, namesPatch, speakerNameProblem, type SpeakerNames as Names } from '../../lib/meetings/speakers'
import { displayText } from '../../lib/text'
import { Button } from '../ui/Button'

type Note = { key: string; ok: boolean; n: number; label?: string } | null

export function SpeakerNames({ meetingId, labels, names, canEdit }: { meetingId: string; labels: string[]; names: Names; canEdit: boolean }) {
  if (labels.length === 0) return null
  return canEdit ? (
    <SpeakerNamesForm meetingId={meetingId} labels={labels} names={names} />
  ) : (
    <SpeakerNamesView labels={labels} names={names} />
  )
}

function SpeakerNamesView({ labels, names }: { labels: string[]; names: Names }) {
  const { t } = useTranslation()
  const named = labels.filter((l) => names[l])
  if (named.length === 0) return null // nothing a viewer can act on
  return (
    <details className="speaker-names">
      <summary>{t('detail.speakers.titleCount', { count: named.length })}</summary>
      <p className="tab-note">{t('detail.speakers.readOnly')}</p>
      <dl className="speaker-fields">
        {named.map((label) => (
          <div key={label}>
            <dt className="bidi-isolate">{displayText(label)}</dt>
            <dd className="bidi-isolate">{displayText(names[label]!)}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

function SpeakerNamesForm({ meetingId, labels, names }: { meetingId: string; labels: string[]; names: Names }) {
  const { t } = useTranslation()
  const save = useSpeakerNames(meetingId)
  const suggestions = useSpeakerSuggestions(true)
  const seed = (from: Names) => Object.fromEntries(labels.map((l) => [l, from[l] ?? '']))
  const [draft, setDraft] = useState<Record<string, string>>(() => seed(names))
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const [seen, setSeen] = useState(names)
  if (seen !== names) {
    // saved names changed (another editor, a refetch): take them into the fields not being edited
    setSeen(names)
    setDraft((d) => Object.fromEntries(labels.map((l) => [l, touched.has(l) ? (d[l] ?? '') : (names[l] ?? '')])))
  }
  const [note, setNote] = useState<Note>(null)
  const [bad, setBad] = useState<string | null>(null) // label of the field in error
  const inputs = useRef(new Map<string, HTMLInputElement>())
  const ids = { list: useId(), base: useId(), err: useId() }
  const show = (key: string, ok: boolean, label?: string) => setNote((p) => ({ key, ok, label, n: (p?.n ?? 0) + 1 }))

  function submit(e: FormEvent) {
    e.preventDefault()
    if (save.isPending) return
    const wrong = labels.find((l) => speakerNameProblem(draft[l] ?? '', l, labels) !== null)
    if (wrong !== undefined) {
      setBad(wrong)
      show(speakerNameProblem(draft[wrong] ?? '', wrong, labels)!, false, wrong)
      inputs.current.get(wrong)?.focus()
      return
    }
    setBad(null)
    const patch = namesPatch(names, draft, touched)
    if (Object.keys(patch).length === 0) return show('detail.speakers.unchanged', true)
    setNote(null)
    save
      .mutateAsync(patch)
      .then((r) => {
        setTouched(new Set())
        setDraft(seed(r.speakerNames))
        show('detail.speakers.saved', true)
      })
      .catch(() => show('detail.speakers.failed', false))
  }

  const message = note ? t(note.key, { label: note.label ? displayText(note.label) : '' }) : ''
  return (
    <details className="speaker-names">
      <summary>{t('detail.speakers.titleCount', { count: labels.length })}</summary>
      <p className="tab-note">{t('detail.speakers.body')}</p>
      <form onSubmit={submit}>
        <datalist id={ids.list}>
          {(suggestions.data ?? []).map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <ul className="speaker-fields">
          {labels.map((label, i) => (
            <li key={label}>
              <label htmlFor={`${ids.base}-${i}`} className="bidi-isolate">
                <span className="sr-only">{t('detail.speakers.namePrefix')} </span>
                {displayText(label)}
              </label>
              <input
                id={`${ids.base}-${i}`}
                ref={(el) => {
                  if (el) inputs.current.set(label, el)
                  else inputs.current.delete(label)
                }}
                type="text"
                list={ids.list}
                autoComplete="off"
                maxLength={MAX_SPEAKER_NAME * 2} // code points ≤ 60 (an emoji is 2 UTF-16 units)
                value={draft[label] ?? ''}
                aria-invalid={bad === label || undefined}
                aria-describedby={bad === label ? ids.err : undefined}
                onChange={(e) => {
                  setDraft((d) => ({ ...d, [label]: e.target.value }))
                  setTouched((s) => new Set(s).add(label))
                  if (note) setNote(null) // no stale "saved" while editing again
                  if (bad === label) setBad(null)
                }}
              />
            </li>
          ))}
        </ul>
        <div className="speaker-actions">
          <Button variant="primary" type="submit" aria-disabled={save.isPending}>
            {save.isPending ? t('detail.speakers.saving') : t('detail.speakers.save')}
          </Button>
          {/* success: one status region always present; errors: a fresh alert node each time */}
          <p className={note?.ok ? 'form-note success' : 'sr-only'} role="status">
            {note?.ok ? message : ''}
          </p>
          {note && !note.ok && (
            <p key={note.n} id={ids.err} className="form-note error" role="alert">
              {message}
            </p>
          )}
        </div>
      </form>
    </details>
  )
}
