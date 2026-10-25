"""ARC-04: settings parsing that the app depends on (pure helpers)."""

import pytest

from app.core.settings import parse_origins


def test_origins_are_split_trimmed_and_deduplicated() -> None:
    raw = " https://app.ricotdin.test ,https://admin.ricotdin.test,https://app.ricotdin.test, "
    assert parse_origins(raw) == ["https://app.ricotdin.test", "https://admin.ricotdin.test"]


def test_empty_means_no_cross_origin_access() -> None:
    assert parse_origins("") == []


@pytest.mark.parametrize(
    "bad", ["*", "https://app.test/", "app.test", "https://app.test/path", "http://a b"]
)
def test_wildcards_paths_and_bare_hosts_are_rejected(bad: str) -> None:
    with pytest.raises(ValueError, match="ALLOWED_ORIGINS"):
        parse_origins(bad)
