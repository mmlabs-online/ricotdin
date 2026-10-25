'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { startCapture, mixToMonoAudioStream, createRecorder } from './capture'
import { isRecordingSupported } from './support'

export type RecorderState = 'idle' | 'recording' | 'stopped' | 'error'

export interface TrackInfo {
  hasMic: boolean
  hasDisplayAudio: boolean
}

export interface UseRecorderReturn {
  state: RecorderState
  elapsedSeconds: number
  blob: Blob | null
  objectUrl: string | null
  mimeType: string | null
  trackInfo: TrackInfo | null
  error: string | null
  supported: boolean
  start: () => Promise<void>
  stop: () => void
  reset: () => void
}

export function useRecorder(): UseRecorderReturn {
  const [state, setState] = useState<RecorderState>('idle')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [mimeType, setMimeType] = useState<string | null>(null)
  const [trackInfo, setTrackInfo] = useState<TrackInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  // All mutable session state lives in refs so event listeners and callbacks
  // always see current values without needing to re-subscribe.
  const recorderRef = useRef<MediaRecorder | null>(null)
  const getBlobRef = useRef<(() => Blob) | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const displayStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef<number>(0)
  // Separate ref for objectUrl so we can revoke it from cleanup/reset/unmount
  // without relying on a potentially stale state closure.
  const objectUrlRef = useRef<string | null>(null)

  // useEffect: guaranteed to run only in the browser, never during SSR.
  // Initial false matches the server render (support.ts guards return false on server),
  // so there is no hydration mismatch. The effect fires after mount and sets the real value.
  const [supported, setSupported] = useState(false)
  useEffect(() => { setSupported(isRecordingSupported()) }, [])

  // ── Helpers ──────────────────────────────────────────────────────────────

  const revokeObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
      setObjectUrl(null)
    }
  }, [])

  /** Stop all media tracks, close the AudioContext, and clear the timer. */
  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    displayStreamRef.current?.getTracks().forEach((t) => t.stop())
    void audioContextRef.current?.close()
    micStreamRef.current = null
    displayStreamRef.current = null
    audioContextRef.current = null
  }, [])

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Start capturing mic + display audio, mix them, and begin recording.
   *
   * Call only in response to a user gesture so the browser allows AudioContext
   * to run immediately.
   */
  const start = useCallback(async () => {
    if (state !== 'idle') return
    setError(null)

    try {
      const { micStream, displayStream } = await startCapture()
      micStreamRef.current = micStream
      displayStreamRef.current = displayStream

      const mix = mixToMonoAudioStream(displayStream, micStream)
      audioContextRef.current = mix.audioContext

      // Some browsers start AudioContext suspended even on a user gesture
      if (mix.audioContext.state === 'suspended') {
        await mix.audioContext.resume()
      }

      const info: TrackInfo = {
        hasMic: micStream.getAudioTracks().length > 0,
        hasDisplayAudio: mix.hasDisplayAudio,
      }
      setTrackInfo(info)
      console.log('[Recorder] tracks captured:', info)

      const kit = createRecorder(mix.mixedStream)
      recorderRef.current = kit.recorder
      getBlobRef.current = kit.getBlob
      setMimeType(kit.mimeType)

      // onstop is set exactly once here. Both the Stop button and the native
      // "Stop sharing" path call recorder.stop(), which triggers this handler.
      kit.recorder.onstop = () => {
        const result = getBlobRef.current ? getBlobRef.current() : new Blob()
        console.log(
          '[Recorder] stopped — blob:',
          (result.size / 1024).toFixed(1),
          'KB, mime:',
          kit.mimeType,
        )
        const url = URL.createObjectURL(result)
        objectUrlRef.current = url
        setBlob(result)
        setObjectUrl(url)
        cleanup()
        setState('stopped')
      }

      // When the user clicks "Stop sharing" in the browser's native bar, the
      // video track (always present) and audio track (if granted) both fire
      // 'ended'. Treat either as an instruction to stop recording.
      const handleTrackEnded = () => {
        if (recorderRef.current?.state === 'recording') {
          if (timerRef.current) {
            clearInterval(timerRef.current)
            timerRef.current = null
          }
          recorderRef.current.stop()
        }
      }
      displayStream.getTracks().forEach((t) => {
        t.addEventListener('ended', handleTrackEnded)
      })

      // timeslice = 250 ms → frequent ondataavailable events for accurate
      // progress (no data is lost if the tab crashes between chunks)
      kit.recorder.start(250)
      startTimeRef.current = Date.now()
      setState('recording')

      timerRef.current = setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000))
      }, 500)
    } catch (err) {
      cleanup()
      const msg = formatError(err)
      // NotAllowedError is a user action (denied the browser prompt), not a
      // code bug — warn so Next.js dev overlay doesn't treat it as fatal.
      if (err instanceof Error && err.name === 'NotAllowedError') {
        console.warn('[Recorder] permission denied by user')
      } else {
        console.error('[Recorder] error:', msg, err)
      }
      setError(msg)
      setState('error')
    }
  }, [state, cleanup])

  /**
   * Stop recording. The onstop handler (set in start()) finalises the blob,
   * sets state to 'stopped', and calls cleanup().
   */
  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop()
    }
  }, [])

  /** Discard the current recording and return to idle. */
  const reset = useCallback(() => {
    revokeObjectUrl()
    setBlob(null)
    setMimeType(null)
    setTrackInfo(null)
    setError(null)
    setElapsedSeconds(0)
    setState('idle')
  }, [revokeObjectUrl])

  // Revoke the object URL and stop any live tracks when the component unmounts
  useEffect(() => {
    return () => {
      revokeObjectUrl()
      cleanup()
    }
  }, [revokeObjectUrl, cleanup])

  return {
    state,
    elapsedSeconds,
    blob,
    objectUrl,
    mimeType,
    trackInfo,
    error,
    supported,
    start,
    stop,
    reset,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  switch (err.name) {
    case 'NotAllowedError':
      return 'Permission denied — allow microphone and screen access, then try again.'
    case 'NotFoundError':
      return 'No microphone found — connect a microphone and try again.'
    case 'AbortError':
      return 'Screen sharing was cancelled.'
    case 'InvalidStateError':
      return 'Recorder entered an invalid state — reset and try again.'
    default:
      return err.message || 'An unexpected error occurred.'
  }
}
