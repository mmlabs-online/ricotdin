"""Order-independent table digests (ARC-03). Pure.

Each row (its columns as Postgres text) is hashed on its own and the hashes are summed modulo
2**256, so source and target can be read in any order (collations differ between Supabase and
Neon) while duplicates, missing rows and changed values still change the digest.
"""

import hashlib
import json
from collections.abc import Sequence

_MOD = 1 << 256


class RowDigest:
    def __init__(self) -> None:
        self.count = 0
        self._sum = 0

    def add(self, row: Sequence[str | None]) -> None:
        # JSON keeps column boundaries and NULL vs '' apart.
        encoded = json.dumps(list(row), ensure_ascii=False, separators=(",", ":")).encode()
        self._sum = (self._sum + int.from_bytes(hashlib.sha256(encoded).digest(), "big")) % _MOD
        self.count += 1

    def hexdigest(self) -> str:
        return f"{self._sum:064x}"
