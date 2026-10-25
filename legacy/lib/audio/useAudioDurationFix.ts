'use client'

// Client hook implementing the `user_hack_audio_render` workaround.
//
// See lib/audio/durationFix.ts for why this is needed. In short: browser
// recordings are live-mode WebM with no Duration and no Cues, so <audio> reports
// duration = Infinity and refuses to seek past what is already buffered.
//
// The hook waits for metadata, then seeks once to HACK_SEEK_TARGET. The media
// engine scans to the end of the stream, fires `durationchange` with a real
// value, and exposes a full seekable range; the hook then restores the playhead.
//
// Cost: the entire file is downloaded up front. That is why this is behind an
// admin flag and defaults to off — the durable fix is remuxing on upload.

import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  HACK_SEEK_TARGET,
  isRecoveredDuration,
  shouldRunDurationFix,
} from '@/lib/audio/durationFix'

export interface AudioDurationFixState {
  /** True while the browser is scanning the stream to discover its length. */
  scanning: boolean
  /** Duration reported by the element, or null while it is still unknown. */
  duration: number | null
}

/**
 * @param audioRef  Ref to the <audio> element.
 * @param enabled   `user_hack_audio_render` flag from GET /api/audio-url/:id.
 * @param src       Current audio URL — the hack re-arms whenever this changes.
 */
export function useAudioDurationFix(
  audioRef: RefObject<HTMLAudioElement | null>,
  enabled: boolean,
  src: string | null,
): AudioDurationFixState {
  const [scanning, setScanning] = useState(false)
  const [duration, setDuration] = useState<number | null>(null)

  // Refs mirror the state for use inside listeners registered once per source.
  const ranRef      = useRef(false) // hack already fired for this source
  const scanningRef = useRef(false) // a scan is currently in flight
  const resumeRef   = useRef(0)     // playhead to restore after the scan

  useEffect(() => {
    const el = audioRef.current
    if (!el || !src) return

    ranRef.current = false
    scanningRef.current = false
    resumeRef.current = 0
    setScanning(false)
    setDuration(null)

    function startScan(node: HTMLAudioElement) {
      resumeRef.current = node.currentTime || 0
      ranRef.current = true
      scanningRef.current = true
      setScanning(true)
      try {
        node.currentTime = HACK_SEEK_TARGET
      } catch {
        // Some engines reject the seek outright instead of clamping to the end.
        scanningRef.current = false
        setScanning(false)
      }
    }

    function endScan(node: HTMLAudioElement) {
      scanningRef.current = false
      setScanning(false)
      try {
        node.currentTime = resumeRef.current
      } catch {
        /* seek can be rejected mid-teardown — harmless */
      }
    }

    function onLoadedMetadata() {
      const node = audioRef.current
      if (!node) return
      if (isRecoveredDuration(node.duration)) {
        setDuration(node.duration)
        return
      }
      if (shouldRunDurationFix({ enabled, duration: node.duration, alreadyRan: ranRef.current })) {
        startScan(node)
      }
    }

    function onDurationChange() {
      const node = audioRef.current
      if (!node || !isRecoveredDuration(node.duration)) return
      setDuration(node.duration)
      if (scanningRef.current) endScan(node)
    }

    el.addEventListener('loadedmetadata', onLoadedMetadata)
    el.addEventListener('durationchange', onDurationChange)

    // Metadata may already have loaded before the listeners were attached.
    if (el.readyState >= 1 /* HAVE_METADATA */) onLoadedMetadata()

    return () => {
      el.removeEventListener('loadedmetadata', onLoadedMetadata)
      el.removeEventListener('durationchange', onDurationChange)
    }
  }, [audioRef, enabled, src])

  return { scanning, duration }
}
