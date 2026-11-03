"""ARC-07: meeting / folder roles (mirrors SQL can_access_meeting and legacy lib/access)."""

import uuid

import pytest

from app.domain.access import can_assign_to_folder, can_view_folder, has_role, meeting_role

ME = uuid.uuid4()
OTHER = uuid.uuid4()
THIRD = uuid.uuid4()


def test_meeting_owner_is_owner_even_in_someone_elses_folder() -> None:
    assert meeting_role(ME, meeting_owner=ME, folder_owner=None, share_role=None) == "owner"
    assert meeting_role(ME, meeting_owner=ME, folder_owner=OTHER, share_role="viewer") == "owner"


def test_folder_owner_owns_every_meeting_in_the_folder() -> None:
    assert meeting_role(ME, meeting_owner=OTHER, folder_owner=ME, share_role=None) == "owner"


def test_share_role_applies() -> None:
    assert (
        meeting_role(ME, meeting_owner=OTHER, folder_owner=THIRD, share_role="editor") == "editor"
    )
    assert (
        meeting_role(ME, meeting_owner=OTHER, folder_owner=THIRD, share_role="viewer") == "viewer"
    )


def test_stranger_has_no_role() -> None:
    """Unlike v1's display helper, a stranger is None, never 'viewer'."""
    assert meeting_role(ME, meeting_owner=OTHER, folder_owner=None, share_role=None) is None
    assert meeting_role(ME, meeting_owner=OTHER, folder_owner=THIRD, share_role=None) is None


def test_unknown_share_role_is_no_role() -> None:
    assert meeting_role(ME, meeting_owner=OTHER, folder_owner=THIRD, share_role="admin") is None


@pytest.mark.parametrize(
    ("role", "minimum", "ok"),
    [
        ("owner", "viewer", True),
        ("owner", "editor", True),
        ("owner", "owner", True),
        ("editor", "viewer", True),
        ("editor", "editor", True),
        ("editor", "owner", False),
        ("viewer", "viewer", True),
        ("viewer", "editor", False),
        (None, "viewer", False),
    ],
)
def test_has_role(role: str | None, minimum: str, ok: bool) -> None:
    assert has_role(role, minimum) is ok  # type: ignore[arg-type]


def test_has_role_rejects_unknown_minimum() -> None:
    with pytest.raises(ValueError):
        has_role("owner", "admin")  # type: ignore[arg-type]


def test_can_assign_to_folder() -> None:
    assert can_assign_to_folder(ME, folder_owner=ME, share_role=None)
    assert can_assign_to_folder(ME, folder_owner=OTHER, share_role="editor")
    assert not can_assign_to_folder(ME, folder_owner=OTHER, share_role="viewer")
    assert not can_assign_to_folder(ME, folder_owner=OTHER, share_role=None)
    assert not can_assign_to_folder(ME, folder_owner=None, share_role=None)  # folder missing


def test_can_view_folder() -> None:  # ARC-09; v1 checkFolderAccess(…, 'viewer')
    assert can_view_folder(ME, folder_owner=ME, share_role=None)
    assert can_view_folder(ME, folder_owner=OTHER, share_role="editor")
    assert can_view_folder(ME, folder_owner=OTHER, share_role="viewer")
    assert not can_view_folder(ME, folder_owner=OTHER, share_role=None)
    assert not can_view_folder(ME, folder_owner=None, share_role=None)  # folder missing
