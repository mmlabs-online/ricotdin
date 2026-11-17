// Speaker names (PRO-04): one name field per transcript label for the owner / editors (with names
// used before as suggestions), the names as text for viewers. Saving updates the transcript at once.
import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useSpeakerNames, useSpeakerSuggestions } from '../../api/meetingDetail'
import { MAX_SPEAKER_NAME, namesPatch, speakerNameProblem, type SpeakerNames as Names } from '../../lib/meetings/speakers'
import { displayText } from '../../lib/text'
import { Button } from '../ui/Button'

export function SpeakerNames({ meetingId, labels, names, canEdit }: { meetingId: string; labels: string[]; names: Names; canEdit: boolean }) {
  const { t } = useTranslation()
  const save = useSpeakerNames(meetingId)
  const suggestions = useSpeakerSuggestions(canEdit)
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(labels.map((l) => [l, names[l] ?? ''])))
  const [note, setNote] = useState<{ key: string; ok: boolean } | null>(null)
  const ids = { list: useId(), base: useId(), note: useId() }
  if (labels.length === 0) return null

  function submit(e: FormEvent) {
    e.preventDefault()
    if (save.isPending) return
    const problem = labels.map((l) => speakerNameProblem(draft[l] ?? '')).find(Boolean)
    if (problem) return setNote({ key: problem, ok: false })
    const patch = namesPatch(names, draft)
    if (Object.keys(patch).length === 0) return setNote({ key: 'detail.speakers.unchanged', ok: true })
    setNote(null)
    save
      .mutateAsync(patch)
      .then((r) => {
        setDraft(Object.fromEntries(labels.map((l) => [l, r.speakerNames[l] ?? ''])))
        setNote({ key: 'detail.speakers.saved', ok: true })
      })
      .catch(() => setNote({ key: 'detail.speakers.failed', ok: false }))
  }

  return (
    <details className="speaker-names">
      <summary>
        {t('detail.speakers.titleCount', { count: labels.length })}
      </summary>
      <p className="tab-note">{t(canEdit ? 'detail.speakers.body' : 'detail.speakers.readOnly')}</p>
      {canEdit ? (
        <form onSubmit={submit} aria-describedby={note ? ids.note : undefined}>
          <datalist id={ids.list}>
            {(suggestions.data ?? []).map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <ul className="speaker-fields">
            {labels.map((label, i) => (
              <li key={label}>
                <label htmlFor={`${ids.base}-${i}`} className="bidi-isolate">
                  {displayText(label)}
                </label>
                <input
                  id={`${ids.base}-${i}`}
                  type="text"
                  list={ids.list}
                  autoComplete="off"
                  maxLength={MAX_SPEAKER_NAME + 20}
                  value={draft[label] ?? ''}
                  placeholder={t('detail.speakers.placeholder')}
                  aria-label={t('detail.speakers.nameFor', { label: displayText(label) })}
                  onChange={(e) => setDraft((d) => ({ ...d, [label]: e.target.value }))}
                />
              </li>
            ))}
          </ul>
          <div className="speaker-actions">
            <Button variant="primary" type="submit" aria-disabled={save.isPending}>
              {save.isPending ? t('detail.speakers.saving') : t('detail.speakers.save')}
            </Button>
            <p id={ids.note} className={note && !note.ok ? 'form-note error' : 'form-note'} role={note && !note.ok ? 'alert' : 'status'}>
              {note ? t(note.key) : ''}
            </p>
          </div>
        </form>
      ) : (
        <dl className="speaker-fields">
          {labels.map((label) => (
            <div key={label}>
              <dt className="bidi-isolate">{displayText(label)}</dt>
              <dd className="bidi-isolate">{names[label] ? displayText(names[label]) : t('detail.speakers.none')}</dd>
            </div>
          ))}
        </dl>
      )}
    </details>
  )
}
