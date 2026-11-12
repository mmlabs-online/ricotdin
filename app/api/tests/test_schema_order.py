"""ARC-02: snapshot ordering must not depend on the database collation (Neon vs CI differ)."""

from app.db.ddl import Column, Policy
from app.db.introspect import Function, Schema, canonical_order


def test_overloads_and_names_sort_by_codepoint_not_collation() -> None:
    s = Schema()
    s.functions = [
        Function(
            "match_transcript_chunks",
            "q vector, meeting_ids uuid[]",
            "b",
            ["service_role", "authenticated"],
            False,
            "s",
        ),
        Function("match_transcript_chunks", "q vector, meeting_id uuid", "a", None, False, "s"),
    ]
    s.indexes = [("t", "idx_b", "x"), ("t", "idx_a_b", "y"), ("t", "idxa", "z")]
    s.constraints = [("t", "t_x_check", "c", "d"), ("t", "t_pkey", "p", "e")]
    s.triggers = [("t", "trg_b", "x"), ("t", "trg_a", "y")]
    s.policies = [
        Policy("t", "own b", True, "ALL", ["ricotdin_service", "ricotdin_app"], None, None),
        Policy("t", "own a", True, "ALL", [], None, None),
    ]
    s.comments = [("t", "b", "x"), ("t", None, "y"), ("t", "a", "z")]
    s.tables = {"b": [Column("c", "int", True)], "a": [Column("c", "int", True)]}
    s.seeds = {"t": '[{"k": "b"}, {"k": "a"}]'}

    canonical_order(s)

    assert s.functions[0].grantees is None
    assert [f.identity_args for f in s.functions] == [
        "q vector, meeting_id uuid",
        "q vector, meeting_ids uuid[]",
    ]
    assert [i[1] for i in s.indexes] == ["idx_a_b", "idx_b", "idxa"]
    assert [c[1] for c in s.constraints] == ["t_pkey", "t_x_check"]
    assert [t[1] for t in s.triggers] == ["trg_a", "trg_b"]
    assert [p.name for p in s.policies] == ["own a", "own b"]
    assert s.policies[1].roles == ["ricotdin_app", "ricotdin_service"]
    assert s.functions[1].grantees == ["authenticated", "service_role"]
    assert [c[1] for c in s.comments] == [None, "a", "b"]
    assert list(s.tables) == ["a", "b"]
    assert s.seeds["t"] == '[{"k": "a"}, {"k": "b"}]'
