// Speaker names per meeting (PRO-04). Pure. The transcript keeps the diarizer's labels
// ("Speaker 1"); `speaker_names` on the meeting maps them to the names people gave.
import { displayText } from '../text'

export const MAX_SPEAKER_NAME = 60 // app/domain/speakers.py

export type SpeakerNames = Record<string, string>

/** Every label once, in order of first appearance (blank labels are not speakers). */
export function speakerLabels(segments: ReadonlyArray<{ speaker: string | null }>): string[] {
  const seen = new Set<string>()
  for (const s of segments) if (s.speaker?.trim()) seen.add(s.speaker)
  return [...seen]
}

/** Segments with the names applied (a new array only when something is named). */
export function applySpeakerNames<T extends { speaker: string | null }>(segments: T[], names: SpeakerNames | undefined | null): T[] {
  const valid = Object.entries(names ?? {}).filter(([, v]) => typeof v === 'string' && v !== '')
  if (valid.length === 0) return segments
  const map = new Map(valid)
  return segments.map((s) => (s.speaker !== null && map.has(s.speaker) ? { ...s, speaker: map.get(s.speaker)! } : s))
}

/** What to send: changed names among the fields the user touched (`null` for a cleared one). An
 *  untouched field may hold an older value than `before` (another editor's save): never sent. */
export function namesPatch(before: SpeakerNames, draft: Record<string, string>, touched: ReadonlySet<string>): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const [label, raw] of Object.entries(draft)) {
    if (!touched.has(label)) continue
    const name = collapse(raw)
    const was = before[label] ?? ''
    if (name === was) continue
    out[label] = name === '' ? null : name
  }
  return out
}

function collapse(name: string): string {
  return name.trim().replace(/\s+/g, ' ')
}

/** i18n key of what is wrong with a typed name, or null (blank clears the name). Same rules as the
 *  API: ≤ 60 code points after collapsing spaces, no invisible characters, no `[]<>`, not another
 *  speaker's label. */
export function speakerNameProblem(name: string, label: string, labels: readonly string[]): string | null {
  const n = collapse(name)
  if ([...n].length > MAX_SPEAKER_NAME) return 'detail.speakers.tooLong'
  if (displayText(n) !== n) return 'detail.speakers.invisible'
  if (/[[\]<>]/.test(n)) return 'detail.speakers.brackets'
  const other = labels.find((l) => l.toLowerCase() === n.toLowerCase())
  if (other !== undefined && other !== label) return 'detail.speakers.otherLabel'
  return null
}
