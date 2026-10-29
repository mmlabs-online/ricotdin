"""Migration report (ARC-03). Pure. Holds hosts, counts, digests, row ids and storage keys
only — never secrets, email addresses or meeting content."""

from dataclasses import dataclass, field


@dataclass
class TableResult:
    table: str
    source_rows: int
    target_rows: int
    source_digest: str
    target_digest: str

    @property
    def ok(self) -> bool:
        return self.source_rows == self.target_rows and self.source_digest == self.target_digest


@dataclass
class StorageResult:
    copied: list[str] = field(default_factory=list)
    already_on_r2: list[str] = field(default_factory=list)
    missing_at_source: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)  # "<key>: <reason>"
    unreferenced_objects: int = 0
    skipped: bool = False
    bucket: str | None = None


@dataclass
class Report:
    started_at: str
    source_host: str
    target_host: str
    tables: list[TableResult] = field(default_factory=list)
    embeddings_source: int = 0
    embeddings_target: int = 0
    secrets_ok: list[str] = field(default_factory=list)
    secrets_failed: list[str] = field(default_factory=list)
    storage: StorageResult = field(default_factory=StorageResult)
    blocked: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)  # "<table>: <class> <sqlstate>"
    source_only_tables: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    dry_run: bool = False

    @property
    def passed(self) -> bool:
        return (
            not self.blocked
            and not self.errors
            and not self.source_only_tables
            and not self.dry_run
            and not self.storage.skipped
            and all(t.ok for t in self.tables)
            and self.embeddings_source == self.embeddings_target
            and not self.secrets_failed
            and not self.storage.failed
        )

    def render(self) -> str:
        lines = [
            "# v2 data migration report (ARC-03)",
            "",
            f"- Started: {self.started_at}",
            f"- Source: `{self.source_host}` → target: `{self.target_host}`",
        ]
        if self.dry_run:
            lines.append("- **Dry run**: nothing was written.")
        if self.blocked:
            lines += ["", "## Blocked (nothing written)", ""]
            lines += [f"- {b}" for b in self.blocked]
        if self.errors:
            lines += ["", "## Errors (run stopped)", ""]
            lines += [f"- ❌ {e}" for e in self.errors]
        if self.source_only_tables:
            lines += ["", "## Source tables with no v2 table (not migrated)", ""]
            lines += [f"- ❌ {t}" for t in self.source_only_tables]
        if self.tables:
            lines += [
                "",
                "## Tables",
                "",
                "| Table | Source rows | Target rows | Match | Digest (source) |",
                "|---|---|---|---|---|",
            ]
            for t in self.tables:
                mark = "✅" if t.ok else "❌"
                lines.append(
                    f"| {t.table} | {t.source_rows} | {t.target_rows} | {mark} | "
                    f"`{t.source_digest[:16]}` |"
                )
            lines += ["", f"Embeddings: {self.embeddings_source} → {self.embeddings_target}"]
        lines += ["", "## Encrypted secrets (test decrypt with KEY_ENCRYPTION_SECRET)", ""]
        lines.append(f"- OK: {len(self.secrets_ok)}")
        lines += [f"- ❌ {s}" for s in self.secrets_failed]
        s = self.storage
        lines += ["", "## Legacy Supabase audio → R2", ""]
        if s.skipped:
            lines.append("- ❌ Skipped (--skip-storage): the run is incomplete.")
        else:
            lines.append(f"- Destination bucket: `{s.bucket or '-'}`")
            lines.append(f"- Copied: {len(s.copied)}")
            lines.append(f"- Already on R2: {len(s.already_on_r2)}")
            lines.append(
                f"- Unreferenced objects in the bucket (not copied): {s.unreferenced_objects}"
            )
            lines.append(f"- Missing at source: {len(s.missing_at_source)}")
            lines += [f"  - `{k}`" for k in s.missing_at_source]
            lines.append(f"- Failed: {len(s.failed)}")
            lines += [f"  - ❌ `{f}`" for f in s.failed]
        if self.notes:
            lines += ["", "## Notes", ""]
            lines += [f"- {n}" for n in self.notes]
        lines += ["", f"**Result: {'PASS' if self.passed else 'FAIL'}**"]
        return "\n".join(lines) + "\n"
