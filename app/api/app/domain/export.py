"""A user's data export (PRF-13 / ADM-11). Pure: the files of the ZIP and the ZIP itself.

Layout: ``README.txt``, ``profile.json``, ``chats.json``, ``activity.json`` and, for each meeting
the user owns, ``meetings/<date>-<slug>-<id8>/meeting.md`` + ``meeting.json``. Speaker names
(PRO-04) are applied; audio is never included."""

import io
import json
import re
import uuid
import zipfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from app.domain.search import fold
from app.domain.speakers import apply_name, clean_names

MAX_SLUG = 40
_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_NONE = "_None._"


@dataclass(frozen=True)
class ExportMeeting:
    id: uuid.UUID
    title: str
    created_at: datetime
    status: str
    duration_seconds: int | None
    language: str | None
    summary: str | None
    notes: str | None
    speaker_names: Mapping[str, str]
    segments: Sequence[Mapping[str, Any]] = field(default_factory=list)
    todos: Sequence[Mapping[str, Any]] = field(default_factory=list)
    calendar: Sequence[Mapping[str, Any]] = field(default_factory=list)


def slugify(title: str) -> str:
    """ASCII, lower case, dashes; never a path (``..``, ``/`` disappear); ``meeting`` if empty."""
    slug = _NON_ALNUM.sub("-", fold(title)).strip("-")[:MAX_SLUG].strip("-")
    return slug or "meeting"


def meeting_folder(m: ExportMeeting) -> str:
    return f"{m.created_at.date().isoformat()}-{slugify(m.title)}-{str(m.id)[:8]}"


def _clock(ms: int | float | None) -> str:
    total = max(0, int((ms or 0) // 1000))
    h, rest = divmod(total, 3600)
    m, s = divmod(rest, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def _names(m: ExportMeeting) -> dict[str, str]:
    return clean_names(dict(m.speaker_names))


def meeting_markdown(m: ExportMeeting) -> str:
    names = _names(m)
    out = [f"# {m.title or 'Untitled meeting'}", ""]
    meta = [m.created_at.date().isoformat()]
    if m.duration_seconds:
        meta.append(_clock(m.duration_seconds * 1000))
    if m.language:
        meta.append(m.language)
    out += [f"*{' · '.join(meta)}*", ""]
    out += ["## Summary", "", (m.summary or "").strip() or _NONE, ""]
    out += ["## Notes", "", (m.notes or "").strip() or _NONE, ""]
    out += ["## To-dos", ""]
    for t in m.todos:
        box = "x" if t.get("status") == "done" else " "
        extra = [str(v) for v in (t.get("assignee"), t.get("due_date")) if v]
        out.append(f"- [{box}] {' — '.join([str(t.get('content') or ''), *extra])}")
    if not m.todos:
        out.append(_NONE)
    out += ["", "## Calendar suggestions", ""]
    for c in m.calendar:
        when = c.get("proposed_at")
        out.append(f"- {c.get('title') or ''}" + (f" — {when}" if when else ""))
    if not m.calendar:
        out.append(_NONE)
    out += ["", "## Transcript", ""]
    last: object = object()
    for s in m.segments:
        speaker = apply_name(s.get("speaker"), names) or "Speaker"
        if speaker != last:
            out += ["", f"**{speaker}**"]
            last = speaker
        out.append(f"- `{_clock(s.get('start_ms'))}` {s.get('text') or ''}")
    if not m.segments:
        out.append(_NONE)
    return "\n".join(out).rstrip() + "\n"


def meeting_json(m: ExportMeeting) -> dict[str, Any]:
    names = _names(m)
    return {
        "id": str(m.id),
        "title": m.title,
        "createdAt": m.created_at.isoformat(),
        "status": m.status,
        "durationSeconds": m.duration_seconds,
        "language": m.language,
        "summary": m.summary,
        "notes": m.notes,
        "speakerNames": names,
        "todos": list(m.todos),
        "calendarSuggestions": list(m.calendar),
        "transcript": [
            {
                "speaker": apply_name(s.get("speaker"), names),
                "label": s.get("speaker"),
                "startMs": s.get("start_ms"),
                "endMs": s.get("end_ms"),
                "text": s.get("text"),
            }
            for s in m.segments
        ],  # fmt: skip
    }


def _readme(generated_at: datetime, meetings: int) -> str:
    return (
        "Ricotdin data export\n"
        f"Created: {generated_at.isoformat()}\n\n"
        f"meetings/   one folder per meeting you own ({meetings}): meeting.md (readable) and\n"
        "            meeting.json (the same data, for programs)\n"
        "profile.json   your profile, preferences and balance\n"
        "chats.json     your chat sessions and messages\n"
        "activity.json  your activity log\n\n"
        "Not included: audio recordings, and meetings other people own and shared with you.\n"
    )


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n"


def export_files(
    *,
    profile: Mapping[str, Any],
    meetings: Sequence[ExportMeeting],
    chats: Sequence[Mapping[str, Any]],
    activity: Sequence[Mapping[str, Any]],
    generated_at: datetime,
) -> dict[str, str]:
    files = {
        "README.txt": _readme(generated_at, len(meetings)),
        "profile.json": _dump(profile),
        "chats.json": _dump(list(chats)),
        "activity.json": _dump(list(activity)),
    }
    for m in meetings:
        base = f"meetings/{meeting_folder(m)}"
        files[f"{base}/meeting.md"] = meeting_markdown(m)
        files[f"{base}/meeting.json"] = _dump(meeting_json(m))
    return files


def build_zip(files: Mapping[str, str], generated_at: datetime) -> bytes:
    buf = io.BytesIO()
    stamp = generated_at.timetuple()[:6]
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, files[name].encode("utf-8"))
    return buf.getvalue()


def export_filename(username: str | None, generated_at: datetime) -> str:
    return f"ricotdin-export-{slugify(username or 'user')}-{generated_at.date().isoformat()}.zip"
