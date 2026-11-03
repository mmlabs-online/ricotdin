"""Runtime prompts from ``ai-instruction/ai-gen/`` (ARC-08c; v1 ``lib/paths/shared.ts``).

The prompt is authored as markdown outside the code so it can change without a code change. It is
read once per process: from the repository (local runs and tests) or ``/app/ai-instruction``
(image; copied by the 08d build).
"""

from functools import cache
from pathlib import Path

from app.core.errors import AppError

ANALYSIS_PROMPT = ("ai-instruction", "ai-gen", "generate-meeting.md")
# The repository root (any parent of this file: local runs, tests) and the image root.
_ROOTS = (*Path(__file__).resolve().parents, Path("/app"))


class PromptUnavailable(AppError):
    status = 500
    code = "prompt_unavailable"
    message = "Processing is not configured correctly. Please contact an administrator."


def prompt_path(parts: tuple[str, ...], roots: tuple[Path, ...] = _ROOTS) -> Path | None:
    for root in roots:
        candidate = root.joinpath(*parts)
        if candidate.is_file():
            return candidate
    return None


@cache
def load_prompt(parts: tuple[str, ...] = ANALYSIS_PROMPT) -> str:
    path = prompt_path(parts)
    if path is None:
        raise PromptUnavailable(detail=f"prompt {'/'.join(parts)} not found")
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n").strip()
    if not text:
        raise PromptUnavailable(detail=f"prompt {'/'.join(parts)} is empty")
    return text
