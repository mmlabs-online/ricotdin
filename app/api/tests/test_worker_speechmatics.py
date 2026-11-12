"""ARC-08b: Speechmatics pure helpers. Port of v1 ``tests/speechmatics.test.ts`` (job config,
speaker labels, json-v2 → segments) plus the v2 helpers (billed seconds, rejection kind, the
no-speech guard of v1 ``tests/processMeeting-guard.test.ts``, key references)."""

from typing import Any

import pytest

from app.services.keys.pool import KeyWithMeta
from app.worker.speechmatics import (
    MAX_TRANSCRIPT_BYTES,
    Segment,
    billed_seconds,
    build_job_config,
    format_speaker_label,
    has_speech,
    is_language_detect_failure,
    key_ref,
    parse_job_status,
    parse_transcript,
    safe_job_id,
)

TWO_SPEAKER_TRANSCRIPT: dict[str, Any] = {
    "metadata": {"transcription_config": {"language": "en", "diarization": "speaker"}},
    "results": [
        {"type": "word", "start_time": 0.16, "end_time": 0.48, "speaker": "S1",
         "alternatives": [{"content": "Hello", "confidence": 0.99, "language": "en"}]},
        {"type": "word", "start_time": 0.52, "end_time": 0.92, "speaker": "S1",
         "alternatives": [{"content": "everyone", "confidence": 0.97, "language": "en"}]},
        {"type": "punctuation", "attaches_to": "previous", "alternatives": [{"content": "."}]},
        {"type": "word", "start_time": 1.20, "end_time": 1.60, "speaker": "S2",
         "alternatives": [{"content": "Hi", "confidence": 0.98, "language": "en"}]},
        {"type": "word", "start_time": 1.64, "end_time": 2.10, "speaker": "S2",
         "alternatives": [{"content": "there", "confidence": 0.96, "language": "en"}]},
        {"type": "punctuation", "attaches_to": "previous", "alternatives": [{"content": ","}]},
        {"type": "word", "start_time": 2.20, "end_time": 2.60, "speaker": "S2",
         "alternatives": [{"content": "thanks", "confidence": 0.95, "language": "en"}]},
    ],
    "speakers": [
        {"name": "S1", "duration": "0.76", "confidence": None},
        {"name": "S2", "duration": "1.76", "confidence": None},
    ],
}  # fmt: skip


def w(start: float, end: float, content: str, who: str | None = "S1", **alt: Any) -> Any:
    word: dict[str, Any] = {"type": "word", "start_time": start, "end_time": end,
                            "alternatives": [{"content": content, **alt}]}  # fmt: skip
    if who is not None:
        word["speaker"] = who
    return word


def p(content: str) -> dict[str, Any]:
    return {
        "type": "punctuation",
        "attaches_to": "previous",
        "alternatives": [{"content": content}],
    }


def segs(results: list[Any], **extra: Any) -> list[Segment]:
    return parse_transcript({"results": results, **extra}).segments


# --- build_job_config ---------------------------------------------------------------------------


def test_config_always_has_speaker_sensitivity() -> None:
    cfg = build_job_config()
    assert cfg["transcription_config"]["speaker_diarization_config"]["speaker_sensitivity"] == 0.5


def test_config_omits_max_speakers_without_a_count() -> None:
    assert (
        "max_speakers"
        not in build_job_config()["transcription_config"]["speaker_diarization_config"]
    )


def test_config_adds_max_speakers_for_a_count() -> None:
    sd = build_job_config(3)["transcription_config"]["speaker_diarization_config"]
    assert sd == {"speaker_sensitivity": 0.5, "max_speakers": 3}


def test_config_defaults() -> None:
    cfg = build_job_config()
    assert cfg["type"] == "transcription"
    tc = cfg["transcription_config"]
    assert (tc["language"], tc["diarization"], tc["operating_point"]) == (
        "auto", "speaker", "enhanced",
    )  # fmt: skip
    assert tc["enable_entities"] is True
    assert tc["punctuation_overrides"] == {"permitted_marks": [".", ",", "?", "!"]}


def test_config_explicit_language_changes_only_the_language() -> None:
    auto, en = build_job_config(2), build_job_config(2, "en")
    assert en["transcription_config"]["language"] == "en"
    en["transcription_config"]["language"] = "auto"
    assert en == auto


@pytest.mark.parametrize("language", [None, "", "  ", "en-US\n", "x" * 40, 5])
def test_config_invalid_language_means_auto(language: Any) -> None:
    assert build_job_config(None, language)["transcription_config"]["language"] == "auto"


# --- format_speaker_label -----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "label"),
    [("S1", "Speaker 1"), ("S12", "Speaker 12"), ("UU", "Speaker"), ("Alice", "Alice")],
)
def test_speaker_labels(raw: str, label: str) -> None:
    assert format_speaker_label(raw) == label


# --- parse_transcript: segments -----------------------------------------------------------------


def test_one_segment_per_speaker_turn() -> None:
    s = parse_transcript(TWO_SPEAKER_TRANSCRIPT).segments
    assert [x.speaker for x in s] == ["Speaker 1", "Speaker 2"]
    assert [x.text for x in s] == ["Hello everyone.", "Hi there, thanks"]
    assert [(x.start_ms, x.end_ms) for x in s] == [(160, 920), (1200, 2600)]


def test_empty_results() -> None:
    assert parse_transcript({"metadata": {}, "results": []}).segments == []
    assert segs([p(".")]) == []


# --- language -----------------------------------------------------------------------------------


def test_language_from_first_word() -> None:
    assert parse_transcript(TWO_SPEAKER_TRANSCRIPT).language == "en"


def test_language_falls_back_to_metadata_then_unknown() -> None:
    meta = {"metadata": {"transcription_config": {"language": "vi"}}}
    assert parse_transcript({**meta, "results": [w(0, 1, "Xin")]}).language == "vi"
    assert parse_transcript({"results": []}).language == "unknown"


# --- speakers -----------------------------------------------------------------------------------


def test_speaker_from_alternatives_first() -> None:
    s = segs([w(0, 1, "Hello", None, speaker="S1"), w(5, 6, "Hi", None, speaker="S2")])
    assert [x.speaker for x in s] == ["Speaker 1", "Speaker 2"]


def test_speaker_fallbacks() -> None:
    assert segs([w(0, 1, "Hello", "S2")])[0].speaker == "Speaker 2"
    assert segs([w(0, 1, "Testing", "UU")])[0].speaker == "Speaker"
    assert segs([w(0, 1, "Hello", None)])[0].speaker == "Speaker 1"


def test_same_speaker_words_stay_together() -> None:
    s = segs([w(0, 0.5, "A"), w(0.6, 1.0, "B"), w(1.1, 1.5, "C")])
    assert [(x.text, x.start_ms, x.end_ms) for x in s] == [("A B C", 0, 1500)]


def test_speaker_change_splits() -> None:
    s = segs([w(0, 0.5, "One"), w(0.6, 1.0, "Two", "S2"), w(1.1, 1.5, "Three")])
    assert [x.text for x in s] == ["One", "Two", "Three"]


# --- punctuation --------------------------------------------------------------------------------


def test_punctuation_attaches_without_a_space() -> None:
    assert segs([w(0, 1, "Hello"), p(","), w(1.1, 1.5, "world"), p("!")])[0].text == (
        "Hello, world!"
    )


def test_orphan_punctuation_is_dropped() -> None:
    assert segs([p("."), w(0, 1, "OK")])[0].text == "OK"


def test_punctuation_at_a_boundary_goes_to_the_outgoing_segment() -> None:
    s = segs([w(0, 1, "Yes"), p("."), w(1.2, 2, "No", "S2")])
    assert [x.text for x in s] == ["Yes.", "No"]


# --- pause splitting ----------------------------------------------------------------------------


def test_pause_over_3s_splits_the_turn() -> None:
    s = segs([w(0, 0.5, "First", confidence=0.8), w(5, 5.5, "Second", confidence=0.6)])
    assert [x.speaker for x in s] == ["Speaker 1", "Speaker 1"]
    assert [x.start_ms for x in s] == [0, 5000]
    assert [x.confidence for x in s] == [0.8, 0.6]


def test_pause_under_3s_does_not_split() -> None:
    assert len(segs([w(0, 0.5, "Hello"), w(2.5, 3.0, "World")])) == 1


# --- confidence ---------------------------------------------------------------------------------


def test_turn_confidence_is_the_rounded_mean() -> None:
    s = parse_transcript(TWO_SPEAKER_TRANSCRIPT).segments
    assert [x.confidence for x in s] == [0.98, 0.96]


def test_confidence_none_without_scores_and_ignores_missing() -> None:
    assert segs([w(0, 1, "Hello"), w(1, 2, "world")])[0].confidence is None
    s = segs([w(0, 0.5, "A", confidence=0.8), w(0.5, 1, "B"), w(1, 1.5, "C", confidence=0.6)])
    assert s[0].confidence == 0.7


def test_confidence_does_not_bleed_across_turns() -> None:
    s = segs([w(0, 1, "One", confidence=1.0), w(1, 2, "Two", "S2", confidence=0.5)])
    assert [x.confidence for x in s] == [1.0, 0.5]


# --- v2: defensive parsing (the response is untrusted input) ------------------------------------


@pytest.mark.parametrize(
    "raw",
    [None, [], "x", {"results": "x"}, {"results": [None, 5, "w", {"type": "word"}]},
     {"results": [{"type": "word", "alternatives": "x"}]},
     {"results": [{"type": "word", "start_time": "1", "alternatives": [{"content": 5}]}]}],
)  # fmt: skip
def test_malformed_input_gives_no_segments(raw: Any) -> None:
    assert parse_transcript(raw).segments == []


def test_bad_numbers_are_ignored() -> None:
    s = segs([w(float("nan"), True, "A", confidence="x"), w(-5, 1e12, "B", confidence=2)])
    assert [(x.text, x.start_ms, x.confidence) for x in s] == [("A B", 0, None)]
    assert all(0 <= x.end_ms <= 2**31 - 1 for x in s)


def test_language_and_labels_are_bounded() -> None:
    raw = {"results": [w(0, 1, "x", "S" + "1" * 200, language="e" * 100)]}
    t = parse_transcript(raw)
    assert t.language == "unknown"
    assert len(t.segments[0].speaker) <= 64


# --- billed seconds -----------------------------------------------------------------------------


def test_billed_seconds_is_the_last_end_time() -> None:
    assert billed_seconds(TWO_SPEAKER_TRANSCRIPT) == 2.6
    assert billed_seconds({"results": []}) == 0.0
    assert billed_seconds({"results": [{"end_time": "9"}, {"end_time": float("inf")}, None]}) == 0


# --- job status / rejection ---------------------------------------------------------------------


def test_parse_job_status() -> None:
    assert parse_job_status({"job": {"id": "a", "status": "running"}}) == ("running", [])
    assert parse_job_status({"job": {"status": "rejected", "errors": [{"message": "m"}]}}) == (
        "rejected", [{"message": "m"}],
    )  # fmt: skip
    for bad in (None, {}, {"job": None}, {"job": {"status": "weird"}}):
        assert parse_job_status(bad) == ("unknown", [])


def test_language_detect_failure() -> None:
    errs = [
        {"timestamp": "t", "message": "Language identification could not identify any language"}
    ]
    assert is_language_detect_failure(errs)
    assert not is_language_detect_failure([{"message": "Audio too short"}])
    assert not is_language_detect_failure([])


# --- no-speech guard (v1 processMeeting-guard) --------------------------------------------------


def test_has_speech() -> None:
    def seg(text: str) -> Segment:
        return Segment("Speaker 1", 0, 1000, text, None)

    assert not has_speech([])
    assert not has_speech([seg("   "), seg("\n\t")])
    assert has_speech([seg("  "), seg("Real speech here")])


# --- key refs and job ids -----------------------------------------------------------------------


def test_key_ref_never_contains_the_key() -> None:
    db = KeyWithMeta("8a7c0000-0000-0000-0000-000000000001", "sk-secret-db")
    env = KeyWithMeta(None, "sk-secret-env")
    assert key_ref(db) == "id:8a7c0000-0000-0000-0000-000000000001"
    ref = key_ref(env)
    assert ref.startswith("env:") and "secret" not in ref and len(ref) == 4 + 16
    assert key_ref(env) == ref and key_ref(KeyWithMeta(None, "other")) != ref


@pytest.mark.parametrize("value", ["a1b2c3d4e5", "JOB_id-123"])
def test_safe_job_id(value: str) -> None:
    assert safe_job_id(value) == value


@pytest.mark.parametrize("value", [None, 5, "", "../x", "a/b", "a?b", "x" * 200])
def test_unsafe_job_id(value: Any) -> None:
    assert safe_job_id(value) is None


def test_transcript_cap() -> None:
    assert MAX_TRANSCRIPT_BYTES == 32 * 1024 * 1024


def test_huge_timestamps_are_capped_not_overflowing() -> None:
    s = segs([w(1e306, 1e306, "A")])
    assert (s[0].start_ms, s[0].end_ms) == (2**31 - 1, 2**31 - 1)


@pytest.mark.parametrize(
    ("value", "hint"),
    [(None, None), (True, None), (1, None), (2, 2), (7, 7), (500, 20), ("3", None)],
)
def test_speaker_count_hint_is_2_to_20(value: Any, hint: int | None) -> None:
    from app.worker.start import speaker_count_hint

    assert speaker_count_hint({"speaker_count": value}) == hint
