# Ricotdin API (v2, FastAPI)

ARC-00 skeleton — the real core is ARC-04 (`ai-instruction/features/feature-Architecture-ARC.md`).

```bash
uv sync                     # install (Python 3.12, from .python-version)
uv run uvicorn app.main:app --reload   # http://localhost:8000/health
uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest -q
```
