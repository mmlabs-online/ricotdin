import { useCallback, useEffect, useRef, useState } from 'react'
import { useFetchApi } from '../../auth/AuthProvider'
import { UploadError, confirmMeetingUpload, putToDrive, uploadErrorKey, uploadMeeting, type PendingConfirm, type UploadMeta } from './upload'

export type UploadStatus =
  | { phase: 'idle' }
  | { phase: 'uploading'; progress: number }
  | { phase: 'done'; meetingId: string }
  | { phase: 'error'; errorKey: string; resume?: PendingConfirm }

/** One upload at a time; progress is the Drive PUT (0–1). */
export function useMeetingUpload() {
  const fetchApi = useFetchApi()
  const [status, setStatus] = useState<UploadStatus>({ phase: 'idle' })
  const busy = useRef(false)
  const statusRef = useRef(status)
  useEffect(() => {
    statusRef.current = status
  }, [status])

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
        const resume = err instanceof UploadError ? err.resume : undefined
        setStatus({ phase: 'error', errorKey: uploadErrorKey(err), ...(resume ? { resume } : {}) })
      } finally {
        busy.current = false
      }
    },
    [fetchApi],
  )

  /** Retry only the confirm: the file is already in Drive, no new meeting or upload. */
  const retryConfirm = useCallback(
    async (pending: PendingConfirm) => {
      if (busy.current) return
      busy.current = true
      setStatus({ phase: 'uploading', progress: 1 })
      try {
        setStatus({ phase: 'done', ...(await confirmMeetingUpload({ fetchApi }, pending, { retry: true })) })
      } catch (err) {
        const resume = err instanceof UploadError ? err.resume : undefined
        setStatus({ phase: 'error', errorKey: uploadErrorKey(err), ...(resume ? { resume } : {}) })
      } finally {
        busy.current = false
      }
    },
    [fetchApi],
  )

  /** Forget the upload. A meeting whose file is in Drive but never confirmed is deleted (the user
   * chose to discard it; it would otherwise hold one of the 20 pending-upload slots). */
  const reset = useCallback(() => {
    const current = statusRef.current
    if (current.phase === 'error' && current.resume) {
      void fetchApi(`/meetings/${encodeURIComponent(current.resume.meetingId)}`, { method: 'DELETE' }).catch(() => undefined)
    }
    setStatus({ phase: 'idle' })
  }, [fetchApi])
  return { status, upload, retryConfirm, reset }
}
