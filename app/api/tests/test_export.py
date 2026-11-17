"""PRF-13 / ADM-11: a user's data export (pure: file names, meeting Markdown / JSON, the ZIP)."""

import io
import json
import uuid
import zipfile
from datetime import UTC, datetime

from app.domain.export import (
    ExportMeeting,
    build_zip,
    export_files,
    meeting_folder,
    meeting_markdown,
    slugify,
)

AT = datetime(2026, 11, 17, 9, 30, tzinfo=UTC)
MID = uuid.UUID("12345678-1234-1234-1234-123456789abc")


def _meeting(**over: object) -> ExportMeeting:
    base: dict[str, object] = {
        "id": MID,
        "title": "Họp ngân sách Q3",
        "created_at": AT,
        "status": "done",
        "duration_seconds": 125,
        "language": "vi",
        "summary": "Chốt ngân sách.",
        "notes": "## Ý chính\n- tăng 10%",
        "speaker_names": {"Speaker 1": "Lan"},
        "segments": [
            {"speaker": "Speaker 1", "start_ms": 0, "end_ms": 4000, "text": "Xin chào"},
            {"speaker": "Speaker 2", "start_ms": 65000, "end_ms": 70000, "text": "Bắt đầu"},
            {"speaker": None, "start_ms": 3_725_000, "end_ms": 3_726_000, "text": "Hết"},
        ],
        "todos": [
            {
                "content": "Gửi báo cáo",
                "assignee": "Lan",
                "due_date": "2026-11-20",
                "status": "open",
            }
        ],  # fmt: skip
        "calendar": [
            {"title": "Review", "proposed_at": "2026-11-21T09:00:00+00:00", "dismissed": False}
        ],  # fmt: skip
    }
    return ExportMeeting(**{**base, **over})  # type: ignore[arg-type]


def test_slugify() -> None:
    assert slugify("Họp ngân sách Q3!") == "hop-ngan-sach-q3"
    assert slugify("   ") == "meeting"
    assert slugify("日本語") == "meeting"
    assert len(slugify("a" * 200)) == 40
    assert slugify("../../etc/passwd") == "etc-passwd"


def test_meeting_folder_is_unique_and_safe() -> None:
    assert meeting_folder(_meeting()) == "2026-11-17-hop-ngan-sach-q3-12345678"


def test_meeting_markdown_has_every_part_with_names() -> None:
    md = meeting_markdown(_meeting())
    assert md.startswith("# Họp ngân sách Q3\n")
    assert "2026-11-17" in md and "02:05" in md  # date, duration
    assert "## Summary\n\nChốt ngân sách." in md
    assert "## Notes\n\n## Ý chính" in md
    assert "- [ ] Gửi báo cáo — Lan — 2026-11-20" in md
    assert "- Review — 2026-11-21T09:00:00+00:00" in md
    assert "**Lan**" in md and "**Speaker 2**" in md and "`01:05`" in md and "`1:02:05`" in md
    assert "Speaker 1" not in md.split("## Transcript")[1]


def test_empty_parts_say_so() -> None:
    md = meeting_markdown(_meeting(summary=None, notes=None, todos=[], calendar=[], segments=[]))
    assert md.count("_None._") == 5


def test_export_files_layout_and_json() -> None:
    files = export_files(
        profile={"username": "lan", "email": "lan@example.test"},
        meetings=[_meeting(), _meeting(id=uuid.UUID(int=7), title="Họp ngân sách Q3")],
        chats=[{"id": "c1", "messages": [{"role": "user", "content": "hi"}]}],
        activity=[{"eventType": "meeting_created"}],
        generated_at=AT,
    )
    assert set(files) == {
        "README.txt",
        "profile.json",
        "chats.json",
        "activity.json",
        "meetings/2026-11-17-hop-ngan-sach-q3-12345678/meeting.md",
        "meetings/2026-11-17-hop-ngan-sach-q3-12345678/meeting.json",
        "meetings/2026-11-17-hop-ngan-sach-q3-00000000/meeting.md",
        "meetings/2026-11-17-hop-ngan-sach-q3-00000000/meeting.json",
    }
    meeting = json.loads(files["meetings/2026-11-17-hop-ngan-sach-q3-12345678/meeting.json"])
    assert meeting["id"] == str(MID) and meeting["speakerNames"] == {"Speaker 1": "Lan"}
    assert meeting["transcript"][0] == {"speaker": "Lan", "label": "Speaker 1", "startMs": 0,
                                        "endMs": 4000, "text": "Xin chào"}  # fmt: skip
    assert json.loads(files["profile.json"])["username"] == "lan"
    assert "2026-11-17" in files["README.txt"] and "audio" in files["README.txt"].lower()


def test_build_zip_round_trips() -> None:
    data = build_zip({"a.txt": "xin chào", "d/b.json": "{}"}, AT)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        assert sorted(z.namelist()) == ["a.txt", "d/b.json"]
        assert z.read("a.txt").decode() == "xin chào"
        assert z.getinfo("a.txt").compress_type == zipfile.ZIP_DEFLATED
