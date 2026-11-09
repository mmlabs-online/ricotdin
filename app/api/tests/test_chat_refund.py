"""SEC-05: which failed chat answers give the agent query back (owner decision 2026-11-09).

Failures on our side are refunded. A provider refusal of the question itself is charged: it is the
one failure a user can cause on purpose, and we still paid for the call."""

import pytest

from app.core.errors import AppError, ServiceUnavailable
from app.rag.answer import answer_refund_reason
from app.services.ai.service import AIBadOutput, AIRejected, AIUnavailable


def test_sec05_a_provider_refusal_is_charged() -> None:
    assert answer_refund_reason(AIRejected()) is None


@pytest.mark.parametrize("exc", [AIUnavailable(), AIBadOutput(), ServiceUnavailable(), AppError()])
def test_sec05_failures_on_our_side_are_refunded(exc: AppError) -> None:
    assert answer_refund_reason(exc) == "answer_generation_failed"
