"""RAG chunking (ARC-08d; port of v1 ``lib/pipeline/chunk.ts``). Pure and deterministic.

About 300 tokens per chunk (1 200 characters, 1 token ≈ 4 characters) with one segment of overlap
between consecutive chunks; a single segment longer than the target is one chunk.
"""

from dataclasses import dataclass

CHUNK_TARGET_CHARS = 1_200
OVERLAP_SEGMENTS = 1


@dataclass(frozen=True)
class ChunkSegment:
    speaker: str | None
    start_ms: int
    end_ms: int
    text: str


@dataclass(frozen=True)
class Chunk:
    chunk_index: int
    content: str
    start_ms: int
    end_ms: int
    token_count: int


def chunk_segments(segments: list[ChunkSegment]) -> list[Chunk]:
    chunks: list[Chunk] = []
    i = 0
    while i < len(segments):
        piece: list[ChunkSegment] = []
        chars = 0
        j = i
        while j < len(segments):
            piece.append(segments[j])
            chars += len(segments[j].text)
            j += 1
            if chars >= CHUNK_TARGET_CHARS:
                break
        content = "\n".join(f"[{s.speaker or ''}] {s.text}" for s in piece)
        chunks.append(
            Chunk(len(chunks), content, piece[0].start_ms, piece[-1].end_ms, -(-len(content) // 4))
        )
        # Overlap only after a full chunk; always move forward (a single long segment).
        i = j if j >= len(segments) else max(i + 1, j - OVERLAP_SEGMENTS)
    return chunks
