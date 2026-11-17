# ruff: noqa: F811 - pytest fixtures imported from the core domain tests are parameters here
"""PRO-04: speaker names end to end (scratch database, the real API): owner and editor set them,
viewers and strangers cannot; labels must exist; names show on the meeting for everyone who can
see it; suggestions come only from meetings the caller can see."""

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.conftest import requires_db
from tests.test_core_domain_integration import (  # noqa: F401 - fixtures
    _as,
    _sql,
    client,
    world,
)

pytestmark = requires_db


@pytest.fixture(scope="module")
def labelled(world: dict[str, Any]) -> Iterator[str]:
    _sql(world["db"], "INSERT INTO transcript_segments (meeting_id, segment_index, speaker, "
         "start_ms, end_ms, text) VALUES (%s, 10, 'Speaker 1', 0, 1000, 'xin chào'), "
         "(%s, 11, 'Speaker 2', 1000, 2000, 'chào bạn')", world["m1"], world["m1"])  # fmt: skip
    yield f"/meetings/{world['m1']}/speakers"


def _patch(client: TestClient, who: str, url: str, names: dict[str, Any]) -> Any:
    return client.patch(url, headers=_as(client, who), json={"names": names})


def test_owner_and_editor_name_speakers_everyone_sees_them(
    client: TestClient, world: dict[str, Any], labelled: str
) -> None:
    r = _patch(client, "a", labelled, {"Speaker 1": "  Lan  "})
    assert r.status_code == 200, r.text
    assert r.json() == {"speakerNames": {"Speaker 1": "Lan"}}
    r = _patch(client, "b", labelled, {"Speaker 2": "Minh"})  # editor of the folder
    assert r.json() == {"speakerNames": {"Speaker 1": "Lan", "Speaker 2": "Minh"}}
    for who in "abc":  # c is a viewer
        meeting = client.get(f"/meetings/{world['m1']}", headers=_as(client, who)).json()
        assert meeting["speaker_names"] == {"Speaker 1": "Lan", "Speaker 2": "Minh"}
    r = _patch(client, "a", labelled, {"Speaker 2": None})
    assert r.json() == {"speakerNames": {"Speaker 1": "Lan"}}


def test_viewers_and_strangers_cannot(client: TestClient, labelled: str) -> None:
    assert _patch(client, "c", labelled, {"Speaker 1": "X"}).status_code == 403
    assert _patch(client, "d", labelled, {"Speaker 1": "X"}).status_code == 404


@pytest.mark.parametrize(
    ("names", "code"),
    [
        ({"Speaker 9": "Lan"}, "bad_request"),
        ({"Speaker 1": "x" * 61}, "bad_request"),
        ({"Speaker 1": "La‮n"}, "invalid_characters"),
        ({}, "bad_request"),
    ],
)
def test_bad_names_are_400(
    client: TestClient, labelled: str, names: dict[str, Any], code: str
) -> None:
    r = _patch(client, "a", labelled, names)
    assert r.status_code == 400 and r.json()["error"]["code"] == code


def test_suggestions_only_from_visible_meetings(
    client: TestClient, world: dict[str, Any], labelled: str
) -> None:
    _patch(client, "a", labelled, {"Speaker 1": "Lan", "Speaker 2": "Minh"})
    _sql(world["db"], "UPDATE meetings SET speaker_names = '{\"Speaker 1\": \"Bí mật\"}' "
         "WHERE id = %s", world["m3"])  # A's private meeting  # fmt: skip
    names = client.get("/speakers/suggestions", headers=_as(client, "a")).json()["names"]
    assert set(names) == {"Lan", "Minh", "Bí mật"}
    names = client.get("/speakers/suggestions", headers=_as(client, "c")).json()["names"]
    assert set(names) == {"Lan", "Minh"}  # C sees M1 (folder share), never A's private M3
    assert client.get("/speakers/suggestions", headers=_as(client, "d")).json() == {"names": []}
    assert client.get("/speakers/suggestions").status_code == 401
