// Own data export and account deletion (PRF-13), admin export of one user (ADM-11).
import { useMutation } from '@tanstack/react-query'
import { useFetchApi } from '../auth/AuthProvider'
import { filenameFromDisposition } from '../lib/profile/account'
import { downloadBlob } from '../lib/media/download'
import type { FetchApi } from './client'
import { apiErrorFrom } from './errors'
import { apiJson } from './json'

/** GET a ZIP export (bearer token, so not a plain link) and save it. Throws ApiError. */
export async function downloadExport(fetchApi: FetchApi, path: string): Promise<void> {
  const res = await fetchApi(path)
  if (!res.ok) throw apiErrorFrom(res.status, await res.json().catch(() => null))
  downloadBlob(await res.blob(), filenameFromDisposition(res.headers.get('content-disposition'), 'ricotdin-export.zip'))
}

export function useExportOwnData() {
  const fetchApi = useFetchApi()
  return useMutation({ mutationFn: () => downloadExport(fetchApi, '/profile/export') })
}

export function useExportUser() {
  const fetchApi = useFetchApi()
  return useMutation({ mutationFn: (id: string) => downloadExport(fetchApi, `/admin/users/${encodeURIComponent(id)}/export`) })
}

export function useDeleteOwnAccount() {
  const fetchApi = useFetchApi()
  return useMutation({
    mutationFn: (confirm: string) =>
      apiJson<{ ok: boolean; storageWarnings?: string[] }>(fetchApi, '/profile', { method: 'DELETE', body: { confirm } }),
  })
}
