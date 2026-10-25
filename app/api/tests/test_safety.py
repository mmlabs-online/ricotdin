"""ARC-02 review: destructive operations only run where they cannot hit real data."""

import pytest

from app.db.safety import DestructiveOperationRefused, check_destructive_allowed, is_scratch_name


def test_scratch_names_need_the_exact_prefix() -> None:
    assert is_scratch_name("ricotdin_test_v2_ab12")
    # LIKE 'ricotdin_test_%' would also have matched these ('_' is a wildcard).
    assert not is_scratch_name("ricotdin-test-x")
    assert not is_scratch_name("ricotdinXtestYz")
    assert not is_scratch_name("neondb")


def test_downgrade_allowed_on_scratch_databases() -> None:
    check_destructive_allowed("ricotdin_test_mig_01", {})


def test_downgrade_refused_on_other_databases_without_explicit_opt_in() -> None:
    with pytest.raises(DestructiveOperationRefused, match="neondb"):
        check_destructive_allowed("neondb", {})
    with pytest.raises(DestructiveOperationRefused):
        check_destructive_allowed("neondb", {"RICOTDIN_ALLOW_DESTRUCTIVE_DOWNGRADE": "yes"})


def test_downgrade_allowed_with_explicit_opt_in() -> None:
    check_destructive_allowed("neondb", {"RICOTDIN_ALLOW_DESTRUCTIVE_DOWNGRADE": "1"})
