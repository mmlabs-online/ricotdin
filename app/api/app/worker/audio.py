"""Audio I/O for the worker (ARC-08): download from Google Drive, ffprobe, video → audio
extraction and transcoding (ports of v1 ``lib/audio/ffprobe.ts`` / ``transcode.ts``).

The audio is untrusted, so every ffmpeg / ffprobe run:
* reads only local files (``-protocol_whitelist file``) and only the demuxers our upload types
  need (``-format_whitelist``): a playlist or concat file disguised as audio cannot make ffmpeg
  open URLs (SSRF) or other local files;
* has a timeout (the process is killed) and never reads stdin;
* gets a minimal environment (no database URL, no KEY_ENCRYPTION_SECRET), 2 threads, RLIMITs
  (2 GiB address space, output file size, CPU time, no core dumps) and output caps
  (``-t`` 6 h, ``-fs`` 1 GiB).
Remaining sandboxing (separate uid, no network, seccomp) is an ARC-15 follow-up (CLAUDE.md §0.7).
The worker runs in its own container with only ``DATABASE_URL_WORKER`` (CLAUDE.md §0.7).
"""

import asyncio
import json
import os
import resource
import signal
from collections.abc import Callable
from pathlib import Path
from typing import Any

import anyio

from app.core.logging import get_logger
from app.db.session import Database
from app.domain.uploads import MAX_STORED_AUDIO_BYTES
from app.services.platform import Platform
from app.services.storage.gdrive import DriveStorage, MemoryObjectMap
from app.worker.errors import PipelineError
from app.worker.policy import MAX_AUDIO_SECONDS
from app.worker.probe import ProbeMode, parse_duration, parse_probe_result

log = get_logger("worker.audio")

WORKER = "ricotdin_worker"
FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"
PROBE_TIMEOUT_S = 60.0
FFMPEG_TIMEOUT_S = 8 * 60.0
INPUT_FORMATS = "matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,mp3,wav,ogg,flac,aac,avi"
INPUT_GUARD = ("-protocol_whitelist", "file", "-format_whitelist", INPUT_FORMATS)
TOOL_THREADS = 2
TOOL_MAX_MEMORY = 2 * 1024**3  # RLIMIT_AS
TOOL_MAX_OUTPUT = 1024**3  # ffmpeg -fs: 6 h of 128 kbps mp3 is ~350 MB
TOOL_MAX_FILE = TOOL_MAX_OUTPUT + 64 * 1024**2  # RLIMIT_FSIZE backstop
# Output options of every ffmpeg run: threads, at most MAX_AUDIO_SECONDS, at most TOOL_MAX_OUTPUT.
OUTPUT_GUARD = ("-threads", str(TOOL_THREADS), "-t", str(MAX_AUDIO_SECONDS), "-fs",
                str(TOOL_MAX_OUTPUT))  # fmt: skip
_STDERR_TAIL = 300
UNREADABLE = "The file could not be read. Please upload a valid audio or video file."


class ToolMissing(Exception):
    """ffmpeg / ffprobe is not installed."""


class ToolFailed(Exception):
    """The tool exited non-zero (message: exit code + stderr tail)."""


def _file(path: Path) -> str:
    return f"file:{path}"  # never read as a protocol or an option


def tool_env() -> dict[str, str]:
    """The child's whole environment: no database URL, no KEY_ENCRYPTION_SECRET."""
    return {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "LANG": "C",
            "LC_ALL": "C"}  # fmt: skip


def _limits(limit_s: float) -> Callable[[], None]:
    cpu = int(limit_s * TOOL_THREADS) + 10  # CPU seconds over all threads, beyond the wall limit

    def apply() -> None:  # runs in the child between fork and exec
        resource.setrlimit(resource.RLIMIT_AS, (TOOL_MAX_MEMORY, TOOL_MAX_MEMORY))
        resource.setrlimit(resource.RLIMIT_FSIZE, (TOOL_MAX_FILE, TOOL_MAX_FILE))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

    return apply


async def run_tool(args: list[str], limit_s: float) -> bytes:
    """Run ``args`` with a minimal environment, stdin from /dev/null and resource limits; stdout
    on exit 0. Killed after ``limit_s`` (TimeoutError) or on cancellation."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, env=tool_env(), preexec_fn=_limits(limit_s),
            start_new_session=True,
        )  # fmt: skip
    except FileNotFoundError:
        raise ToolMissing(f"{args[0]} not found") from None
    try:
        with anyio.fail_after(limit_s):
            stdout, stderr = await proc.communicate()
    except BaseException:
        if proc.returncode is None:
            try:  # its own session: kill the whole group (helpers ffmpeg may have spawned)
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            with anyio.CancelScope(shield=True):
                await proc.wait()
        raise
    if proc.returncode != 0:
        tail = stderr.decode("utf-8", "replace")[-_STDERR_TAIL:].strip()
        raise ToolFailed(f"{args[0]} exited {proc.returncode}: {tail}")
    return stdout


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
    except (ToolFailed, ValueError, TimeoutError) as exc:  # a crafted file: never retried
        raise PipelineError(
            UNREADABLE, detail=f"ffprobe failed to analyse the file: {type(exc).__name__}: {exc}"
        ) from None
    result = parse_probe_result(data, mode)
    if not result.valid:
        raise PipelineError(f"Invalid file: {result.reason}")
    return parse_duration(data)


async def extract_audio(video: Path, out: Path) -> Path:
    """Audio track of a video as mp3 (v1 ``extractAudioFromVideo``: ``-vn``, libmp3lame 128k)."""
    try:
        await run_tool(
            [FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", *INPUT_GUARD,
             "-threads", str(TOOL_THREADS), "-i", _file(video), "-vn", "-c:a", "libmp3lame",
             "-b:a", "128k", *OUTPUT_GUARD, _file(out)],
            FFMPEG_TIMEOUT_S,
        )  # fmt: skip
    except ToolMissing:
        raise PipelineError(
            "Audio processing is not available right now. Please contact an administrator.",
            detail="ffmpeg is required to extract audio from a video",
        ) from None
    except (ToolFailed, TimeoutError) as exc:
        raise PipelineError(
            "The audio track could not be extracted from this video.",
            detail=f"audio extraction failed: {type(exc).__name__}: {exc}",
        ) from None
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
             "-threads", str(TOOL_THREADS), "-i", _file(source), "-ac", "1", "-ar", "16000",
             "-b:a", "64k", *OUTPUT_GUARD, _file(out)],
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
        raise PipelineError(
            "The audio file is missing from storage.", detail=f"key {key!r} unmapped"
        )
    reader = DriveStorage(
        storage.client, MemoryObjectMap({key: obj}), storage.signer, storage.web_origin
    )
    return await reader.download_to_file(key, target, max_bytes=MAX_STORED_AUDIO_BYTES)
