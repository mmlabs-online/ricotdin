"""ffprobe output parsing (ARC-08; port of v1 ``parseProbeResult`` / ``parseDurationFromProbe``).
Pure. ``app.worker.audio`` runs the process.

* ``audio-only`` (recordings and uploaded audio): ≥ 1 audio stream and no video stream.
* ``video`` (``source = 'video'``): ≥ 1 audio stream (it is extracted); video is fine.
Other stream types (data, attachment, subtitle) are ignored.
"""

import math
from dataclasses import dataclass
from typing import Any, Literal

ProbeMode = Literal["audio-only", "video"]


@dataclass(frozen=True)
class ProbeResult:
    valid: bool
    reason: str | None = None


def _has(streams: list[Any], codec_type: str) -> bool:
    return any(
        isinstance(s, dict)
        and isinstance(s.get("codec_type"), str)
        and s["codec_type"].lower() == codec_type
        for s in streams
    )


def parse_probe_result(probe: Any, mode: ProbeMode = "audio-only") -> ProbeResult:
    if not isinstance(probe, dict):
        return ProbeResult(False, "ffprobe output is not a JSON object")
    streams = probe.get("streams")
    if not isinstance(streams, list):
        return ProbeResult(False, "ffprobe output has no streams array")
    if mode == "audio-only" and _has(streams, "video"):
        return ProbeResult(
            False, "File contains a video stream — only audio-only files are supported"
        )
    if not _has(streams, "audio"):
        return ProbeResult(False, "File contains no audio stream")
    return ProbeResult(True)


def parse_duration(probe: Any) -> float:
    """``format.duration`` in seconds, or 0 when missing or not a positive finite number."""
    if not isinstance(probe, dict):
        return 0.0
    fmt = probe.get("format")
    if not isinstance(fmt, dict) or not isinstance(fmt.get("duration"), str):
        return 0.0
    try:
        seconds = float(fmt["duration"])
    except ValueError:
        return 0.0
    return seconds if math.isfinite(seconds) and seconds > 0 else 0.0
