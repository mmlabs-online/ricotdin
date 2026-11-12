// Meeting audio player (MTD-02, §9j). Native controls; `hackAudioRender` turns on the live-WebM
// duration fix. ARC-13 places it in the meeting detail screen; seekTo() serves transcript
// timestamps and chat citations.
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { resolveDuration } from '../lib/audio/durationFix'
import { useAudioDurationFix } from '../lib/audio/useAudioDurationFix'
import { formatClock } from '../lib/media/seek'

export interface AudioPlayerHandle {
  /** Jump to a time (ms) and play. */
  seekTo: (ms: number) => void
}

export const AudioPlayer = forwardRef<
  AudioPlayerHandle,
  {
    src: string | null
    hackAudioRender: boolean
    fallbackSeconds?: number | null
    label: string
    /** The link expired or failed: the caller fetches a new one. */
    onError?: () => void
  }
>(function AudioPlayer({ src, hackAudioRender, fallbackSeconds = null, label, onError }, ref) {
  const { t } = useTranslation()
  const audioRef = useRef<HTMLAudioElement>(null)
  const { scanning, duration } = useAudioDurationFix(audioRef, hackAudioRender, src)
  const shown = resolveDuration(duration, fallbackSeconds)
  // A seek asked for while the duration scan runs would be undone when the scan restores the
  // playhead: keep it and apply it once the scan is over.
  const pendingSeek = useRef<number | null>(null)
  useEffect(() => {
    const el = audioRef.current
    if (scanning || !el || pendingSeek.current === null) return
    el.currentTime = pendingSeek.current / 1000
    pendingSeek.current = null
    void el.play().catch(() => undefined)
  }, [scanning])

  useImperativeHandle(ref, () => ({
    seekTo(ms: number) {
      const el = audioRef.current
      if (!el || !Number.isFinite(ms) || ms < 0) return
      if (scanning) {
        pendingSeek.current = ms
        return
      }
      el.currentTime = ms / 1000
      void el.play().catch(() => undefined) // autoplay policy: the user can press play
    },
  }))

  if (!src) return null
  return (
    <div className="audio-native">
      <audio ref={audioRef} src={src} controls preload="metadata" aria-label={label} onError={onError} />
      <span className="audio-meta" role="status">
        {scanning ? t('player.scanning') : shown !== null ? formatClock(shown) : ''}
      </span>
    </div>
  )
})
