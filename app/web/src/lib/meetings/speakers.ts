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

/** What to send: changed names, and `null` for a name that was cleared. */
export function namesPatch(before: SpeakerNames, draft: Record<string, string>): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const [label, raw] of Object.entries(draft)) {
    const name = raw.trim().replace(/\s+/g, ' ')
    const was = before[label] ?? ''
    if (name === was) continue
    out[label] = name === '' ? null : name
  }
  return out
}

/** i18n key of what is wrong with a typed name, or null (blank clears the name). */
export function speakerNameProblem(name: string): string | null {
  const n = name.trim()
  if (n.length > MAX_SPEAKER_NAME) return 'detail.speakers.tooLong'
  if (displayText(n) !== n) return 'detail.speakers.invisible'
  return null
}
