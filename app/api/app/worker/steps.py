"""The worker's step registry (ARC-08). ``embed`` arrives with 08d; until then
``python -m app.worker`` refuses to start (``policy.missing_steps``)."""

from app.worker.analyse import run_analyse
from app.worker.jobs import StepHandler
from app.worker.start import run_start
from app.worker.transcribe_poll import run_transcribe_poll


def default_steps() -> dict[str, StepHandler]:
    return {"start": run_start, "transcribe_poll": run_transcribe_poll, "analyse": run_analyse}
