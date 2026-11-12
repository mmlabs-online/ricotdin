-- Migration 031: seed the `user_hack_audio_render` feature flag
--
-- Browser recordings are live-mode WebM/Opus (MediaRecorder output): the Segment
-- Info header carries an unknown Duration and the file has no Cues, so <audio>
-- reports duration = Infinity and cannot seek. When this flag is ON the meeting
-- detail player performs a one-time seek to a huge timestamp, forcing the browser
-- to scan the stream and expose a real duration + full seekable range.
--
-- Trade-off: the whole file is downloaded up front. Default OFF.
-- The durable fix is remuxing the upload into a container with Duration + Cues.

INSERT INTO public.app_config (key, value, description) VALUES
  (
    'user_hack_audio_render',
    'false',
    'Force the meeting audio player to recover a seekable duration for browser-recorded WebM (downloads the full file up front). Default off.'
  )
ON CONFLICT (key) DO NOTHING;
