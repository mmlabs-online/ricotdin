"""Speechmatics pure helpers (ARC-08b; port of v1 ``lib/speechmatics/transcribe.ts``).

The json-v2 transcript is untrusted input (it comes back over the network): every field is
type-checked, numbers must be finite, and values written to the database are bounded.
"""

import hashlib
import json
import math
import re
from dataclasses import dataclass
from typing import Any

from app.services.keys.pool import KeyWithMeta

# Within one speaker's turn, a silence longer than this starts a new segment (v1).
PAUSE_SPLIT_THRESHOLD_S = 3.0
# v1 rejection text when automatic language detection is not confident; retried once with 'en'.
LANG_DETECT_FAIL = "Language identification could not identify"
MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024  # 6 h of words is ~10-20 MB of json-v2
MAX_SPEAKER_LEN = 64
_MAX_MS = 2**31 - 1  # transcript_segments.start_ms / end_ms are integer
_LANGUAGE = re.compile(r"[a-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,2}")
_JOB_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
JOB_STATUSES = ("running", "done", "rejected", "deleted")


@dataclass(frozen=True)
class Segment:
    speaker: str
    start_ms: int
    end_ms: int
    text: str
    confidence: float | None


@dataclass(frozen=True)
class Transcript:
    language: str
    segments: list[Segment]


def valid_language(value: object) -> str | None:
    return value if isinstance(value, str) and _LANGUAGE.fullmatch(value) else None


def build_job_config(speaker_count: int | None = None, language: object = None) -> dict[str, Any]:
    """v1 ``buildJobConfig``. ``language`` None / invalid → ``auto`` (built-in detection)."""
    diarization: dict[str, Any] = {"speaker_sensitivity": 0.5}
    if speaker_count is not None:
        diarization["max_speakers"] = speaker_count
    return {
        "type": "transcription",
        "transcription_config": {
            "language": valid_language(language) or "auto",
            "diarization": "speaker",
            "operating_point": "enhanced",
            "enable_entities": True,
            "punctuation_overrides": {"permitted_marks": [".", ",", "?", "!"]},
            "speaker_diarization_config": diarization,
        },
    }


def format_speaker_label(raw: str) -> str:
    """``S1`` → ``Speaker 1``, ``UU`` → ``Speaker``, anything else unchanged (bounded)."""
    if re.fullmatch(r"S\d+", raw):
        label = f"Speaker {raw[1:]}"
    elif raw == "UU":
        label = "Speaker"
    else:
        label = raw
    return label[:MAX_SPEAKER_LEN]


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    value = float(value)
    return value if math.isfinite(value) and value >= 0 else None


def _ms(seconds: float) -> int:
    return round(min(seconds, _MAX_MS / 1000) * 1000)  # cap first: 1e306 * 1000 is inf


def _alternative(result: dict[str, Any]) -> dict[str, Any]:
    alts = result.get("alternatives")
    if isinstance(alts, list) and alts and isinstance(alts[0], dict):
        return alts[0]
    return {}


def _results(raw: object) -> list[dict[str, Any]]:
    results = raw.get("results") if isinstance(raw, dict) else None
    return [r for r in results if isinstance(r, dict)] if isinstance(results, list) else []


def _language(raw: object, results: list[dict[str, Any]]) -> str:
    for r in results:
        if r.get("type") == "word":
            found = valid_language(_alternative(r).get("language"))
            if found:
                return found
    meta = raw.get("metadata") if isinstance(raw, dict) else None
    config = meta.get("transcription_config") if isinstance(meta, dict) else None
    found = valid_language(config.get("language")) if isinstance(config, dict) else None
    return found or "unknown"


def parse_transcript(raw: object) -> Transcript:
    """v1 ``parseTranscriptResponse``: words grouped by speaker turn, a new segment on a speaker
    change or a pause over 3 s, ``attaches_to: previous`` punctuation glued to the last word
    (orphans dropped), per-segment confidence = mean of the word scores rounded to 2 places."""
    results = _results(raw)
    segments: list[Segment] = []
    speaker: str | None = None
    start = end = 0.0
    words: list[str] = []
    scores: list[float] = []

    def flush() -> None:
        if speaker is not None and words:
            conf = round(sum(scores) / len(scores), 2) if scores else None
            segments.append(
                Segment(format_speaker_label(speaker), _ms(start), _ms(end), " ".join(words), conf)
            )

    for r in results:
        alt = _alternative(r)
        content = alt.get("content")
        if r.get("type") == "word":
            if not isinstance(content, str) or not content:
                continue
            label = alt.get("speaker") if isinstance(alt.get("speaker"), str) else r.get("speaker")
            label = label if isinstance(label, str) and label else "S1"
            word_start = _number(r.get("start_time")) or 0.0
            if label != speaker or (words and word_start - end > PAUSE_SPLIT_THRESHOLD_S):
                flush()
                speaker, start, words, scores = label, word_start, [], []
                end = word_start
            word_end = _number(r.get("end_time"))
            if word_end is not None:
                end = word_end
            words.append(content)
            score = _number(alt.get("confidence"))
            if score is not None and score <= 1:
                scores.append(score)
        elif r.get("type") == "punctuation" and r.get("attaches_to") == "previous":
            if words and isinstance(content, str):
                words[-1] += content
    flush()
    return Transcript(_language(raw, results), segments)


def billed_seconds(raw: object) -> float:
    """Seconds Speechmatics processed: the largest ``end_time`` (v1)."""
    ends = [_number(r.get("end_time")) for r in _results(raw)]
    return max((e for e in ends if e is not None), default=0.0)


def parse_job_status(raw: object) -> tuple[str, list[Any]]:
    job = raw.get("job") if isinstance(raw, dict) else None
    if not isinstance(job, dict) or job.get("status") not in JOB_STATUSES:
        return "unknown", []
    errors = job.get("errors")
    return str(job["status"]), errors if isinstance(errors, list) else []


def is_language_detect_failure(errors: list[Any]) -> bool:
    return LANG_DETECT_FAIL in json.dumps(errors, default=str)


def has_speech(segments: list[Segment]) -> bool:
    """v1 ``assertTranscriptHasSpeech``: at least one segment with non-blank text."""
    return any(s.text.strip() for s in segments)


def key_ref(key: KeyWithMeta) -> str:
    """Which key holds a provider job, stored in ``jobs.payload``: the ``admin_config`` id, or a
    short hash for an env fallback key. Never the key itself."""
    if key.id:
        return f"id:{key.id}"
    return "env:" + hashlib.sha256(key.key.encode()).hexdigest()[:16]


def safe_job_id(value: object) -> str | None:
    """A provider job id is used in a URL path: only ``[A-Za-z0-9_-]{1,64}``."""
    return value if isinstance(value, str) and _JOB_ID.fullmatch(value) else None
