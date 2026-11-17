"""Speaker names per meeting (PRO-04). Pure.

``meetings.speaker_names`` maps a transcript label (``Speaker 1``, set by the diarizer per
recording) to the name a person gave it. Labels are never rewritten in the segments; names are
applied where text is shown or sent to the AI."""

import json
import re
from collections import Counter
from collections.abc import Iterable, Mapping
from typing import Any

from app.core.errors import BadRequest
from app.domain.rules import INVISIBLE_MESSAGE, InvalidNameCharacters, has_invisible_characters

MAX_NAME_CHARS = 60
MAX_SUGGESTIONS = 50
_LINE_LABEL = re.compile(r"^\[([^\]\n]+)\]", re.MULTILINE)  # chunk lines: "[Speaker 1] text"


def parse_speaker_patch(body: Mapping[str, Any], labels: set[str]) -> dict[str, str | None]:
    """``{"names": {label: name | null}}`` → cleaned changes; ``null`` / blank clears a name."""
    names = body.get("names")
    if not isinstance(names, dict) or not names:
        raise BadRequest("Send the speaker names to change.")
    out: dict[str, str | None] = {}
    for label, value in names.items():
        if label not in labels:
            raise BadRequest("That speaker is not in this meeting.")
        if value is None:
            out[label] = None
            continue
        if not isinstance(value, str):
            raise BadRequest("A speaker name must be text.")
        name = " ".join(value.split())
        if len(name) > MAX_NAME_CHARS:
            raise BadRequest(f"A speaker name can be at most {MAX_NAME_CHARS} characters.")
        if has_invisible_characters(name):
            raise InvalidNameCharacters(INVISIBLE_MESSAGE)
        out[label] = name or None
    return out


def merge_names(current: Mapping[str, str], changes: Mapping[str, str | None]) -> dict[str, str]:
    merged = dict(current)
    for label, name in changes.items():
        if name is None:
            merged.pop(label, None)
        else:
            merged[label] = name
    return merged


def clean_names(raw: Any) -> dict[str, str]:
    """The stored map, defensively: text keys to non-empty text values (bounded). A jsonb value
    that arrives as text is decoded first."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return {}
    if not isinstance(raw, dict):
        return {}
    return {
        k: v[:MAX_NAME_CHARS]
        for k, v in raw.items()
        if isinstance(k, str) and isinstance(v, str) and v
    }


def apply_name(label: str | None, names: Mapping[str, str]) -> str | None:
    if label is None:
        return None
    return names.get(label, label)


def rename_chunk(content: str, names: Mapping[str, str]) -> str:
    """Embedded chunk text (``[Speaker 1] …`` per line, ``worker/chunk.py``) with the names."""
    if not names:
        return content
    return _LINE_LABEL.sub(lambda m: f"[{names.get(m.group(1), m.group(1))}]", content)


def rank_suggestions(maps: Iterable[Mapping[str, str]], limit: int = MAX_SUGGESTIONS) -> list[str]:
    """Names used before, most used first (case-insensitive; the most common spelling wins)."""
    counts: Counter[str] = Counter()
    spellings: dict[str, Counter[str]] = {}
    for names in maps:
        for name in clean_names(names).values():
            key = name.casefold()
            counts[key] += 1
            spellings.setdefault(key, Counter())[name] += 1
    ranked = sorted(counts, key=lambda k: (-counts[k], k))[:limit]
    return [spellings[k].most_common(1)[0][0] for k in ranked]
