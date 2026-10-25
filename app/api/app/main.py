"""Ricotdin v2 API (FastAPI). ARC-00 skeleton; the real core comes in ARC-04."""

from fastapi import FastAPI

app = FastAPI(title="Ricotdin API", version="0.0.0")


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness for the image HEALTHCHECK: no DB or provider calls."""
    return {"status": "ok"}
