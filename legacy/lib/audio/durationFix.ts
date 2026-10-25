// Pure helpers for the seekable-audio duration fix. No I/O — safe on both sides.
//
// WHY THIS EXISTS
// ---------------
// Browser recordings are produced by MediaRecorder as live-mode WebM/Opus
// (see lib/audio/support.ts). A live-mode WebM has an *unknown* Duration in its
// Segment Info header and carries no Cues (seek index). The consequences in the
// <audio> element are:
//   1. `duration` is Infinity — the native control shows no total length,
//   2. there is no time→byte map, so the browser cannot Range-request a seek,
//   3. the scrub bar only covers bytes already downloaded.
//
// The workaround ("render hack") is to seek to an absurdly large time once
// metadata has loaded. The browser then scans the whole stream, discovers the
// real end, fires `durationchange` with a finite value, and exposes a full
// seekable range. Cost: the entire file is fetched up front.
//
// This is a mitigation, not a cure — the real fix is remuxing the upload into a
// container that has Duration + Cues. It is therefore gated behind the
// `user_hack_audio_render` admin flag (app_config), default OFF.

/**
 * Seek target used to force a full-stream scan.
 * Any value the media engine clamps to "end of stream" works; 1e101 is the
 * conventional choice and is comfortably finite (Infinity is rejected by
 * `currentTime` setters).
 */
export const HACK_SEEK_TARGET = 1e101

/**
 * True when the element's reported duration is unusable and the file is
 * therefore not freely seekable.
 *
 * @param duration  `HTMLMediaElement.duration` (Infinity / NaN when unknown).
 */
export function needsDurationFix(duration: number | null | undefined): boolean {
  if (duration === null || duration === undefined) return true
  return !Number.isFinite(duration) || duration <= 0
}

/** True once the browser reports a real, finite duration. Inverse of `needsDurationFix`. */
export function isRecoveredDuration(duration: number | null | undefined): boolean {
  return !needsDurationFix(duration)
}

/**
 * Decide whether to fire the render hack for the current media element state.
 * Kept separate from the hook so the gating rules are unit-testable.
 *
 * @param enabled     Value of the `user_hack_audio_render` admin flag.
 * @param duration    `HTMLMediaElement.duration` at `loadedmetadata` time.
 * @param alreadyRan  Whether the hack has already fired for this source.
 */
export function shouldRunDurationFix({
  enabled,
  duration,
  alreadyRan,
}: {
  enabled: boolean
  duration: number | null | undefined
  alreadyRan: boolean
}): boolean {
  if (!enabled) return false
  if (alreadyRan) return false
  return needsDurationFix(duration)
}

/**
 * Best available duration for display: the element's own value when it is real,
 * otherwise the client-measured `meetings.duration_seconds` recorded at upload.
 *
 * @returns Seconds, or null when neither source has a usable value.
 */
export function resolveDuration(
  audioDuration: number | null | undefined,
  fallbackSeconds: number | null | undefined,
): number | null {
  if (isRecoveredDuration(audioDuration)) return audioDuration as number
  if (fallbackSeconds != null && Number.isFinite(fallbackSeconds) && fallbackSeconds > 0) {
    return fallbackSeconds
  }
  return null
}
