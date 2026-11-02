"""ARC-08 worker audio tools against real ffmpeg / ffprobe (skipped where they are missing):
stream validation, duration, transcode, video → audio extraction, and the input guards
(local files only, allowed demuxers only, timeouts)."""

import shutil
import subprocess
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import anyio
import pytest

from app.worker import audio
from app.worker.errors import PipelineError

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe not installed",
)


def make_media(path: Path, *, seconds: float = 2.0, video: bool = False) -> Path:
    args = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi",
            "-i", f"sine=frequency=440:duration={seconds}"]  # fmt: skip
    if video:
        args += ["-f", "lavfi", "-i", f"testsrc=size=64x48:rate=5:duration={seconds}"]
    subprocess.run([*args, str(path)], check=True)  # noqa: S603, S607 - fixed test command
    return path


def _run(fn: Callable[..., Awaitable[Any]], *args: Any) -> Any:
    return anyio.run(fn, *args)


def test_inspect_returns_the_duration_of_audio(tmp_path: Path) -> None:
    src = make_media(tmp_path / "a.webm")
    assert _run(audio.inspect, src, "audio-only") == pytest.approx(2.0, abs=0.1)


def test_inspect_rejects_video_for_audio_meetings(tmp_path: Path) -> None:
    src = make_media(tmp_path / "v.mp4", video=True)
    with pytest.raises(PipelineError, match="video stream"):
        _run(audio.inspect, src, "audio-only")
    assert _run(audio.inspect, src, "video") == pytest.approx(2.0, abs=0.2)


def test_inspect_rejects_a_file_that_is_not_media(tmp_path: Path) -> None:
    src = tmp_path / "x.webm"
    src.write_bytes(b"this is not audio" * 100)
    with pytest.raises(PipelineError, match="ffprobe failed to analyse the file"):
        _run(audio.inspect, src, "audio-only")


def test_a_playlist_disguised_as_audio_is_not_followed(tmp_path: Path) -> None:
    # HLS / concat playlists could make ffmpeg open URLs or other local files (SSRF, file read).
    # The extensions make plain ffprobe follow them (checked below); the guard must refuse.
    make_media(tmp_path / "real.mp3")
    for name, body in [
        ("hls.m3u8", "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nreal.mp3\n#EXT-X-ENDLIST\n"),
        ("list.ffconcat", "ffconcat version 1.0\nfile 'real.mp3'\n"),
    ]:
        src = tmp_path / name
        src.write_text(body)
        unguarded = subprocess.run(  # noqa: S603 - fixed test command
            ["ffprobe", "-v", "error", "-show_format", f"file:{src}"],  # noqa: S607
            capture_output=True,
        )
        assert unguarded.returncode == 0  # without the guard the playlist is opened
        with pytest.raises(PipelineError, match="ffprobe failed"):
            _run(audio.inspect, src, "audio-only")
        assert _run(audio.transcode, src, tmp_path) == src  # transcode refuses too: original kept


def test_transcode_makes_a_mono_16k_mp3(tmp_path: Path) -> None:
    src = make_media(tmp_path / "a.webm")
    out = _run(audio.transcode, src, tmp_path)
    assert out == tmp_path / "audio.mp3" and out.stat().st_size > 0
    probe = _run(audio.probe, out)
    stream = probe["streams"][0]
    assert (stream["codec_name"], stream["sample_rate"], stream["channels"]) == ("mp3", "16000", 1)


def test_transcode_keeps_mp3_and_falls_back_to_the_original(tmp_path: Path) -> None:
    mp3 = make_media(tmp_path / "a.mp3")
    assert _run(audio.transcode, mp3, tmp_path) == mp3
    junk = tmp_path / "junk.webm"
    junk.write_bytes(b"\x00" * 1000)
    assert _run(audio.transcode, junk, tmp_path) == junk
    assert not (tmp_path / "audio.mp3").exists()


def test_extract_audio_from_video(tmp_path: Path) -> None:
    src = make_media(tmp_path / "v.mp4", video=True)
    out = _run(audio.extract_audio, src, tmp_path / "extracted.mp3")
    probe = _run(audio.probe, out)
    assert [s["codec_type"] for s in probe["streams"]] == ["audio"]


def test_extract_audio_failure_is_terminal(tmp_path: Path) -> None:
    junk = tmp_path / "v.mp4"
    junk.write_bytes(b"\x00" * 1000)
    with pytest.raises(PipelineError, match="Audio extraction"):
        _run(audio.extract_audio, junk, tmp_path / "out.mp3")


def test_run_tool_kills_a_process_past_its_limit() -> None:
    async def go() -> None:
        with anyio.fail_after(5):  # the test itself never hangs
            await audio.run_tool(["sleep", "30"], 0.2)

    with pytest.raises(TimeoutError):
        anyio.run(go)


def test_missing_tools(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(audio.ToolMissing):
        anyio.run(audio.run_tool, ["ricotdin-no-such-tool"], 1.0)
    src = make_media(tmp_path / "a.webm")
    monkeypatch.setattr(audio, "FFPROBE", "ricotdin-no-such-tool")
    monkeypatch.setattr(audio, "FFMPEG", "ricotdin-no-such-tool")
    assert _run(audio.inspect, src, "audio-only") == 0.0  # v1: validation skipped
    assert _run(audio.transcode, src, tmp_path) == src
    with pytest.raises(PipelineError, match="ffmpeg is required"):
        _run(audio.extract_audio, src, tmp_path / "x.mp3")
