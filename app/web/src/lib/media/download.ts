// Browser downloads (ARC-12): `.ics` for a calendar suggestion (fetched with the bearer token, so
// a plain link cannot be used) and generated text files (transcript export).
import type { FetchApi } from '../../api/client'
import { apiErrorFrom } from '../../api/errors'
import { icsFilename } from './seek'

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** CAL-01: GET /calendar-suggestions/{id}/ics → file. Throws ApiError (422 without a time). */
export async function downloadIcs(fetchApi: FetchApi, suggestionId: string, title: string): Promise<void> {
  const res = await fetchApi(`/calendar-suggestions/${encodeURIComponent(suggestionId)}/ics`)
  if (!res.ok) throw apiErrorFrom(res.status, await res.json().catch(() => null))
  downloadBlob(await res.blob(), icsFilename(title))
}
