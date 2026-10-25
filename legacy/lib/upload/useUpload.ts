'use client'

import { useCallback, useState } from 'react'
import { uploadRecording, UploadError } from './upload'
import type { RecordingMeta } from './upload'

export type UploadState = 'idle' | 'uploading' | 'done' | 'error'

export interface UseUploadReturn {
  state: UploadState
  meetingId: string | null
  error: string | null
  upload: (blob: Blob, meta: RecordingMeta) => Promise<void>
  reset: () => void
}

export function useUpload(): UseUploadReturn {
  const [state, setState] = useState<UploadState>('idle')
  const [meetingId, setMeetingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const upload = useCallback(async (blob: Blob, meta: RecordingMeta) => {
    if (state === 'uploading') return
    setState('uploading')
    setError(null)
    setMeetingId(null)

    try {
      const result = await uploadRecording(blob, meta)
      setMeetingId(result.meetingId)
      setState('done')
    } catch (err) {
      const msg =
        err instanceof UploadError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Upload failed.'
      setError(msg)
      setState('error')
    }
  }, [state])

  const reset = useCallback(() => {
    setState('idle')
    setMeetingId(null)
    setError(null)
  }, [])

  return { state, meetingId, error, upload, reset }
}
