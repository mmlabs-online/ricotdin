import { useCallback, useRef, useState } from 'react'
import { useFetchApi } from '../../auth/AuthProvider'
import { putToDrive, uploadErrorKey, uploadMeeting, type UploadMeta } from './upload'

export type UploadStatus =
  | { phase: 'idle' }
  | { phase: 'uploading'; progress: number }
  | { phase: 'done'; meetingId: string }
  | { phase: 'error'; errorKey: string }

/** One upload at a time; progress is the Drive PUT (0–1). */
export function useMeetingUpload() {
  const fetchApi = useFetchApi()
  const [status, setStatus] = useState<UploadStatus>({ phase: 'idle' })
  const busy = useRef(false)

  const upload = useCallback(
    async (blob: Blob, meta: UploadMeta) => {
      if (busy.current) return
      busy.current = true
      setStatus({ phase: 'uploading', progress: 0 })
      try {
        const { meetingId } = await uploadMeeting(
          { fetchApi, putFile: (url, b, type, onProgress) => putToDrive(url, b, type, onProgress) },
          blob,
          meta,
          (progress) => setStatus({ phase: 'uploading', progress }),
        )
        setStatus({ phase: 'done', meetingId })
      } catch (err) {
        setStatus({ phase: 'error', errorKey: uploadErrorKey(err) })
      } finally {
        busy.current = false
      }
    },
    [fetchApi],
  )

  const reset = useCallback(() => setStatus({ phase: 'idle' }), [])
  return { status, upload, reset }
}
