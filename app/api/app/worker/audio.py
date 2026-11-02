"""Audio I/O for the worker (ARC-08): download from Google Drive, ffprobe, video → audio
extraction and transcoding (ports of v1 ``lib/audio/ffprobe.ts`` / ``transcode.ts``).

The audio is untrusted, so every ffmpeg / ffprobe run:
* reads only local files (``-protocol_whitelist file``) and only the demuxers our upload types
  need (``-format_whitelist``): a playlist or concat file disguised as audio cannot make ffmpeg
  open URLs (SSRF) or other local files;
* has a timeout (the process is killed) and never reads stdin.
The worker runs in its own container with only ``DATABASE_URL_WORKER`` (CLAUDE.md §0.7).
"""

import json
from pathlib import Path
from typing import Any

import anyio

from app.core.logging import get_logger
from app.db.session import Database
from app.domain.uploads import MAX_UPLOAD_BYTES
from app.services.platform import Platform
from app.services.storage.gdrive import DriveStorage, MemoryObjectMap
from app.worker.errors import PipelineError
from app.worker.probe import ProbeMode, parse_duration, parse_probe_result

log = get_logger("worker.audio")

WORKER = "ricotdin_worker"
FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"
PROBE_TIMEOUT_S = 60.0
FFMPEG_TIMEOUT_S = 8 * 60.0
INPUT_FORMATS = "matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,mp3,wav,ogg,flac,aac,avi"
INPUT_GUARD = ("-protocol_whitelist", "file", "-format_whitelist", INPUT_FORMATS)
_STDERR_TAIL = 300


class ToolMissing(Exception):
    """ffmpeg / ffprobe is not installed."""


class ToolFailed(Exception):
    """The tool exited non-zero (message: exit code + stderr tail)."""


def _file(path: Path) -> str:
    return f"file:{path}"  # never read as a protocol or an option


async def run_tool(args: list[str], limit_s: float) -> bytes:
    """Run ``args``; stdout on exit 0. Killed after ``limit_s`` (TimeoutError)."""
    try:
        with anyio.fail_after(limit_s):
            result = await anyio.run_process(args, check=False)
    except FileNotFoundError:
        raise ToolMissing(f"{args[0]} not found") from None
    if result.returncode != 0:
        tail = result.stderr.decode("utf-8", "replace")[-_STDERR_TAIL:].strip()
        raise ToolFailed(f"{args[0]} exited {result.returncode}: {tail}")
    return result.stdout


async def probe(path: Path) -> Any:
    out = await run_tool(
        [FFPROBE, "-v", "error", *INPUT_GUARD, "-print_format", "json", "-show_streams",
         "-show_format", _file(path)],
        PROBE_TIMEOUT_S,
    )  # fmt: skip
    return json.loads(out)


async def inspect(path: Path, mode: ProbeMode) -> float:
    """Validate the streams (terminal ``PipelineError`` if invalid) and return the duration in
    seconds (0 when unknown). Without ffprobe the check is skipped, like v1."""
    try:
        data = await probe(path)
    except ToolMissing:
        log.warning("ffprobe not found: stream validation and duration estimate skipped")
        return 0.0
    except (ToolFailed, ValueError) as exc:
        raise PipelineError(f"ffprobe failed to analyse the file: {exc}") from None
    result = parse_probe_result(data, mode)
    if not result.valid:
        raise PipelineError(f"Invalid file: {result.reason}")
    return parse_duration(data)


async def extract_audio(video: Path, out: Path) -> Path:
    """Audio track of a video as mp3 (v1 ``extractAudioFromVideo``: ``-vn``, libmp3lame 128k)."""
    try:
        await run_tool(
            [FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", *INPUT_GUARD,
             "-i", _file(video), "-vn", "-c:a", "libmp3lame", "-b:a", "128k", _file(out)],
            FFMPEG_TIMEOUT_S,
        )  # fmt: skip
    except ToolMissing:
        raise PipelineError("ffmpeg is required to extract audio from a video") from None
    except ToolFailed as exc:
        raise PipelineError(f"Audio extraction from the video failed: {exc}") from None
    return out


async def transcode(source: Path, out_dir: Path) -> Path:
    """Mono 16 kHz 64 kbps mp3 for the transcriber (v1). An mp3 is used as is; any failure keeps
    the original file (v1: the transcriber accepts most formats)."""
    if source.suffix.lower() == ".mp3":
        return source
    out = out_dir / "audio.mp3"
    try:
        await run_tool(
            [FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", *INPUT_GUARD,
             "-i", _file(source), "-ac", "1", "-ar", "16000", "-b:a", "64k", _file(out)],
            FFMPEG_TIMEOUT_S,
        )  # fmt: skip
    except (ToolMissing, ToolFailed, TimeoutError) as exc:
        log.warning("transcode failed, using the original file (%s)", type(exc).__name__)
        await anyio.Path(out).unlink(missing_ok=True)
        return source
    return out


async def download(db: Database, platform: Platform, key: str, target: Path) -> int:
    """Stream the stored file to ``target``. The caller has checked ``key`` belongs to the
    meeting (``owned_audio_path``). The map lookup is a short ``ricotdin_worker`` transaction;
    the download itself holds no connection (idle-in-transaction timeout, pool size)."""
    async with db.role_transaction(WORKER) as conn:
        storage = await platform.storage(conn)
        obj = await storage.stat(key)
    if obj is None:
        raise PipelineError("The audio file is missing from storage.")
    reader = DriveStorage(
        storage.client, MemoryObjectMap({key: obj}), storage.signer, storage.web_origin
    )
    return await reader.download_to_file(key, target, max_bytes=MAX_UPLOAD_BYTES)
