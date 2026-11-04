// Recorder hook (ported from v1 lib/audio/useRecorder.ts for ARC-12; REC-01..04).
// Mic + tab/system audio are mixed into one audio-only stream and recorded with MediaRecorder.
// `start` must run inside a user gesture (the notice's confirm click) so the browser's
// screen-share prompt keeps user activation.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRecorder, mixToMonoAudioStream, startCapture } from './capture'
import { missingRecordingCapabilities, recorderErrorKey } from './support'

export type RecorderState = 'idle' | 'starting' | 'recording' | 'stopped' | 'error'

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
  /** i18n key of the last error */
  errorKey: string | null
  /** i18n keys of missing browser capabilities (empty = supported) */
  missing: string[]
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
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [missing] = useState<string[]>(() => missingRecordingCapabilities())

  const stateRef = useRef<RecorderState>('idle')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const displayStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const objectUrlRef = useRef<string | null>(null)

  const setBoth = useCallback((next: RecorderState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  /** Stop all tracks, close the AudioContext and the timer. */
  const cleanup = useCallback(() => {
    clearTimer()
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    displayStreamRef.current?.getTracks().forEach((t) => t.stop())
    void audioContextRef.current?.close().catch(() => undefined)
    micStreamRef.current = null
    displayStreamRef.current = null
    audioContextRef.current = null
  }, [clearTimer])

  const revokeObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
      setObjectUrl(null)
    }
  }, [])

  const start = useCallback(async () => {
    if (stateRef.current !== 'idle') return
    setBoth('starting')
    setErrorKey(null)
    try {
      const { micStream, displayStream } = await startCapture()
      micStreamRef.current = micStream
      displayStreamRef.current = displayStream
      const mix = mixToMonoAudioStream(displayStream, micStream)
      audioContextRef.current = mix.audioContext
      if (mix.audioContext.state === 'suspended') await mix.audioContext.resume()
      setTrackInfo({ hasMic: micStream.getAudioTracks().length > 0, hasDisplayAudio: mix.hasDisplayAudio })

      const kit = createRecorder(mix.mixedStream)
      recorderRef.current = kit.recorder
      setMimeType(kit.mimeType)
      kit.recorder.onstop = () => {
        const result = kit.getBlob()
        const url = URL.createObjectURL(result)
        objectUrlRef.current = url
        setBlob(result)
        setObjectUrl(url)
        cleanup()
        setBoth('stopped')
      }
      // "Stop sharing" in the browser bar ends the display tracks: stop recording too.
      const onEnded = () => {
        clearTimer()
        if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
      }
      displayStream.getTracks().forEach((t) => t.addEventListener('ended', onEnded))

      kit.recorder.start(250) // frequent chunks: little is lost if the tab crashes
      const startedAt = Date.now()
      setElapsedSeconds(0)
      setBoth('recording')
      timerRef.current = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 500)
    } catch (err) {
      cleanup()
      setErrorKey(recorderErrorKey(err))
      setBoth('error')
    }
  }, [cleanup, clearTimer, setBoth])

  const stop = useCallback(() => {
    clearTimer()
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }, [clearTimer])

  const reset = useCallback(() => {
    cleanup()
    revokeObjectUrl()
    recorderRef.current = null
    setBlob(null)
    setMimeType(null)
    setTrackInfo(null)
    setErrorKey(null)
    setElapsedSeconds(0)
    setBoth('idle')
  }, [cleanup, revokeObjectUrl, setBoth])

  useEffect(
    () => () => {
      if (recorderRef.current?.state === 'recording') {
        recorderRef.current.onstop = null
        recorderRef.current.stop()
      }
      cleanup()
      revokeObjectUrl()
    },
    [cleanup, revokeObjectUrl],
  )

  return { state, elapsedSeconds, blob, objectUrl, mimeType, trackInfo, errorKey, missing, start, stop, reset }
}
