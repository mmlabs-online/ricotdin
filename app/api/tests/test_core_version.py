"""ARC-04: GET /version.json value — RICOTDIN_VERSION, then the build commit, then "unknown"
(same contract as v1 legacy/lib/release/version.ts)."""

import pytest

from app.core.version import resolve_version


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({"RICOTDIN_VERSION": "v2.0.0", "BUILD_COMMIT": "abc1234"}, "v2.0.0"),
        ({"RICOTDIN_VERSION": "  v2.0.1 ", "BUILD_COMMIT": "abc"}, "v2.0.1"),
        ({"RICOTDIN_VERSION": "", "BUILD_COMMIT": "abc1234def"}, "abc1234def"),
        ({"RICOTDIN_VERSION": "   ", "BUILD_COMMIT": " "}, "unknown"),
        ({}, "unknown"),
    ],
)
def test_resolve_version(env: dict[str, str], expected: str) -> None:
    assert resolve_version(env) == expected
