"""``python -m app.worker`` — the pipeline worker process (ARC-08, CLAUDE.md §0.7).

Same image as the API, its own container, and only ``DATABASE_URL_WORKER`` (plus
``KEY_ENCRYPTION_SECRET``): the process refuses to start when any other database URL or
server secret is present (ARC-04 security review), and while pipeline steps are missing
(``embed`` arrives with 08d; not deployable before then). SIGTERM / SIGINT
stop the loop after the current claim; a step still running after ``SHUTDOWN_GRACE_S`` is
cancelled and its job released (queued again at once).
"""

import os
import signal
import sys
from collections.abc import Mapping

import anyio

from app.core.logging import get_logger, setup_logging
from app.core.sentry import init_sentry
from app.core.settings import Settings
from app.core.version import resolve_version
from app.db.session import Database
from app.services.ai.service import AIService
from app.services.platform import Platform
from app.worker.jobs import StepHandler
from app.worker.policy import missing_steps, worker_env_problems
from app.worker.runner import JobRunner
from app.worker.speechmatics_client import SpeechmaticsTranscriber
from app.worker.steps import default_steps

log = get_logger("worker")

SHUTDOWN_GRACE_S = 8.0  # below docker's default 10 s stop timeout (compose: stop_grace_period 30s)


def startup_problems(env: Mapping[str, str], steps: Mapping[str, StepHandler]) -> list[str]:
    problems = worker_env_problems(env)
    missing = missing_steps(steps)
    if missing:
        problems.append("pipeline steps not implemented yet: " + ", ".join(missing))
    return problems


async def _serve(settings: Settings, steps: Mapping[str, StepHandler]) -> None:
    platform = Platform.from_settings(settings)
    db = await Database.start(settings)
    transcriber: SpeechmaticsTranscriber | None = None
    ai: AIService | None = None
    try:
        transcriber = SpeechmaticsTranscriber(db, platform.keys)
        ai = AIService(platform.keys)
        runner = JobRunner(db, platform, steps, transcriber=transcriber, ai=ai)
        stop = anyio.Event()
        async with anyio.create_task_group() as tg:

            async def watch_signals() -> None:
                with anyio.open_signal_receiver(signal.SIGTERM, signal.SIGINT) as signals:
                    async for _ in signals:
                        log.info("shutdown requested")
                        stop.set()
                        await anyio.sleep(SHUTDOWN_GRACE_S)
                        tg.cancel_scope.cancel()  # a step still running: release its job
                        return

            async def work() -> None:
                await runner.run_forever(stop)
                tg.cancel_scope.cancel()

            tg.start_soon(watch_signals)
            tg.start_soon(work)
    finally:
        with anyio.CancelScope(shield=True):
            if transcriber is not None:
                await transcriber.aclose()
            if ai is not None:
                await ai.aclose()
            await db.close()
            await platform.aclose()


def main() -> int:
    settings = Settings()
    setup_logging(settings.log_level)
    release = resolve_version(os.environ)
    init_sentry(settings.sentry_dsn.get_secret_value() if settings.sentry_dsn else None, release)
    steps = default_steps()
    problems = startup_problems(os.environ, steps)
    if problems:
        for problem in problems:
            log.error("worker refused to start: %s", problem)
        return 2
    anyio.run(_serve, settings, steps)
    return 0


if __name__ == "__main__":
    sys.exit(main())
