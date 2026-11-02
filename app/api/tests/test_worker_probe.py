"""ARC-08 worker: ffprobe output parsing. Port of legacy/tests/ffprobe.test.ts (all 24 cases of
``parseProbeResult``) plus ``parseDurationFromProbe``. Pure: no process I/O."""

from typing import Any

import pytest

from app.worker.probe import ProbeResult, parse_duration, parse_probe_result

AUDIO_ONLY_MP3 = {
    "streams": [
        {
            "index": 0,
            "codec_name": "mp3",
            "codec_type": "audio",
            "sample_rate": "44100",
            "channels": 2,
        }
    ]
}
AUDIO_ONLY_WAV = {
    "streams": [
        {
            "index": 0,
            "codec_name": "pcm_s16le",
            "codec_type": "audio",
            "sample_rate": "16000",
            "channels": 1,
        }
    ]
}
AUDIO_ONLY_WEBM = {
    "streams": [
        {
            "index": 0,
            "codec_name": "opus",
            "codec_type": "audio",
            "sample_rate": "48000",
            "channels": 2,
        }
    ]
}
AUDIO_ONLY_AAC = {
    "streams": [
        {
            "index": 0,
            "codec_name": "aac",
            "codec_type": "audio",
            "sample_rate": "44100",
            "channels": 2,
        }
    ]
}
VIDEO_WITH_AUDIO = {
    "streams": [
        {"index": 0, "codec_name": "h264", "codec_type": "video"},
        {"index": 1, "codec_name": "aac", "codec_type": "audio"},
    ]
}
VIDEO_ONLY = {"streams": [{"index": 0, "codec_name": "h264", "codec_type": "video"}]}
MULTI_AUDIO = {
    "streams": [
        {"index": 0, "codec_name": "mp3", "codec_type": "audio", "channels": 1},
        {"index": 1, "codec_name": "opus", "codec_type": "audio", "channels": 2},
    ]
}
EMPTY_STREAMS: dict[str, Any] = {"streams": []}


# --- valid audio-only files (5) ---------------------------------------------------------------


def test_accepts_mp3() -> None:
    result = parse_probe_result(AUDIO_ONLY_MP3)
    assert result.valid
    assert result.reason is None


def test_accepts_wav() -> None:
    assert parse_probe_result(AUDIO_ONLY_WAV).valid


def test_accepts_webm_with_opus_audio() -> None:
    assert parse_probe_result(AUDIO_ONLY_WEBM).valid


def test_accepts_aac() -> None:
    assert parse_probe_result(AUDIO_ONLY_AAC).valid


def test_accepts_multiple_audio_streams_without_video() -> None:
    assert parse_probe_result(MULTI_AUDIO).valid


# --- rejected files (4) -----------------------------------------------------------------------


def test_rejects_a_file_that_has_a_video_stream() -> None:
    result = parse_probe_result(VIDEO_WITH_AUDIO)
    assert not result.valid
    assert result.reason is not None and "video" in result.reason.lower()


def test_rejects_a_video_only_file() -> None:
    result = parse_probe_result(VIDEO_ONLY)
    assert not result.valid
    assert result.reason is not None and "video" in result.reason.lower()


def test_rejects_a_file_with_no_streams_at_all() -> None:
    result = parse_probe_result(EMPTY_STREAMS)
    assert not result.valid
    assert result.reason is not None and "audio" in result.reason.lower()


def test_rejects_when_streams_array_is_missing() -> None:
    assert not parse_probe_result({}).valid


# --- garbage input (6) ------------------------------------------------------------------------


def test_returns_invalid_for_null_input() -> None:
    assert not parse_probe_result(None).valid


def test_returns_invalid_for_string_input() -> None:
    assert not parse_probe_result("not json").valid


def test_returns_invalid_for_number_input() -> None:
    assert not parse_probe_result(42).valid


def test_returns_invalid_when_streams_is_not_an_array() -> None:
    assert not parse_probe_result({"streams": "not-an-array"}).valid


def test_skips_stream_entries_that_lack_codec_type() -> None:
    assert not parse_probe_result({"streams": [{"index": 0, "codec_name": "unknown"}]}).valid


def test_treats_data_streams_as_non_blocking() -> None:
    result = parse_probe_result(
        {
            "streams": [
                {"codec_type": "audio", "codec_name": "mp3"},
                {"codec_type": "data", "codec_name": "bin_data"},
                {"codec_type": "attachment", "codec_name": "none"},
            ]
        }
    )
    assert result.valid, result.reason


# --- edge cases (2) ---------------------------------------------------------------------------


def test_is_case_insensitive_on_codec_type() -> None:
    assert parse_probe_result({"streams": [{"codec_type": "Audio", "codec_name": "mp3"}]}).valid


def test_rejects_when_video_stream_has_codec_type_in_uppercase() -> None:
    streams = [
        {"codec_type": "Audio", "codec_name": "aac"},
        {"codec_type": "Video", "codec_name": "h264"},
    ]
    assert not parse_probe_result({"streams": streams}).valid


# --- mode='video' (7) -------------------------------------------------------------------------


def test_video_mode_accepts_video_plus_audio() -> None:
    result = parse_probe_result(VIDEO_WITH_AUDIO, "video")
    assert result.valid, result.reason


def test_video_mode_accepts_audio_only() -> None:
    assert parse_probe_result(AUDIO_ONLY_MP3, "video").valid


def test_video_mode_accepts_webm_with_video_and_audio() -> None:
    mixed = {
        "streams": [
            {"codec_name": "vp9", "codec_type": "video"},
            {"codec_name": "opus", "codec_type": "audio"},
        ]
    }
    assert parse_probe_result(mixed, "video").valid


def test_video_mode_rejects_a_video_only_file() -> None:
    result = parse_probe_result(VIDEO_ONLY, "video")
    assert not result.valid
    assert result.reason is not None and "audio" in result.reason.lower()


def test_video_mode_rejects_empty_streams() -> None:
    assert not parse_probe_result(EMPTY_STREAMS, "video").valid


def test_video_mode_rejects_null_input() -> None:
    assert not parse_probe_result(None, "video").valid


def test_video_mode_is_case_insensitive_on_codec_type() -> None:
    streams = [
        {"codec_type": "Video", "codec_name": "h264"},
        {"codec_type": "Audio", "codec_name": "aac"},
    ]
    assert parse_probe_result({"streams": streams}, "video").valid


# --- v2 additions -----------------------------------------------------------------------------


def test_probe_result_is_a_value() -> None:
    assert parse_probe_result(AUDIO_ONLY_MP3) == ProbeResult(True)


def test_non_dict_stream_entries_are_ignored() -> None:
    assert parse_probe_result({"streams": ["audio", None, {"codec_type": "audio"}]}).valid


@pytest.mark.parametrize(
    ("probe", "seconds"),
    [
        ({"format": {"duration": "79.520000"}}, 79.52),
        ({"format": {"duration": "0"}}, 0.0),
        ({"format": {"duration": "-1"}}, 0.0),
        ({"format": {"duration": "N/A"}}, 0.0),
        ({"format": {"duration": "inf"}}, 0.0),
        ({"format": {"duration": "nan"}}, 0.0),
        ({"format": {"duration": 12.5}}, 0.0),  # v1 accepts only the string form ffprobe prints
        ({"format": {}}, 0.0),
        ({"format": "x"}, 0.0),
        ({}, 0.0),
        (None, 0.0),
        ([1, 2], 0.0),
    ],
)
def test_parse_duration(probe: Any, seconds: float) -> None:
    assert parse_duration(probe) == pytest.approx(seconds)
