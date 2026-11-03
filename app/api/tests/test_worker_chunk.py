"""ARC-08d: RAG chunking — port of v1 ``tests/chunk.test.ts`` (``lib/pipeline/chunk.ts``)."""

from app.worker.chunk import CHUNK_TARGET_CHARS, ChunkSegment, chunk_segments


def seg(i: int, text: str, speaker: str | None = "Speaker 1") -> ChunkSegment:
    return ChunkSegment(speaker, i * 1000, (i + 1) * 1000, text)


def test_empty() -> None:
    assert chunk_segments([]) == []


def test_short_transcript_is_one_chunk() -> None:
    (c,) = chunk_segments([seg(0, "Hello world"), seg(1, "How are you")])
    assert (c.chunk_index, c.start_ms, c.end_ms) == (0, 0, 2000)
    assert c.content == "[Speaker 1] Hello world\n[Speaker 1] How are you"


def test_indexes_are_sequential() -> None:
    chunks = chunk_segments([seg(i, "a" * 500) for i in range(10)])
    assert len(chunks) > 1
    assert [c.chunk_index for c in chunks] == list(range(len(chunks)))


def test_every_segment_is_covered() -> None:
    segs = [seg(i, f"word{i} " * 10) for i in range(20)]
    chunks = chunk_segments(segs)
    for s in segs:
        assert any(s.text in c.content for c in chunks)


def test_time_range_and_token_count() -> None:
    for c in chunk_segments([seg(i, "hello") for i in range(5)]):
        assert 0 <= c.start_ms <= c.end_ms
    (c,) = chunk_segments([seg(0, "a" * 400)])
    assert c.token_count == -(-len(c.content) // 4)  # ceil(len / 4)


def test_speaker_labels_and_a_missing_one() -> None:
    (c,) = chunk_segments([seg(0, "Q", "Speaker 1"), seg(1, "A", "Speaker 2"), seg(2, "x", None)])
    assert c.content.splitlines() == ["[Speaker 1] Q", "[Speaker 2] A", "[] x"]  # v1: speaker ?? ''


def test_consecutive_chunks_overlap_by_one_segment() -> None:
    chunks = chunk_segments([seg(i, "x" * 700) for i in range(6)])
    assert len(chunks) >= 2
    for prev, cur in zip(chunks, chunks[1:], strict=False):
        assert set(cur.content.splitlines()) & set(prev.content.splitlines())


def test_exact_v1_boundaries() -> None:
    # 700 + 700 ≥ 1200 → chunk [0, 1]; overlap 1 → next starts at 1: [1, 2], [2, 3], [3, 4], [4, 5]
    chunks = chunk_segments([seg(i, "x" * 700) for i in range(6)])
    assert [(c.start_ms, c.end_ms) for c in chunks] == [
        (0, 2000), (1000, 3000), (2000, 4000), (3000, 5000), (4000, 6000),
    ]  # fmt: skip
    assert CHUNK_TARGET_CHARS == 1200


def test_a_single_long_segment_is_one_chunk() -> None:
    (c,) = chunk_segments([seg(0, "z" * 5000)])
    assert c.chunk_index == 0
