"""Repository paths shared by scripts (the v1 schema replay was removed with ARC-16)."""

from pathlib import Path

API_ROOT = Path(__file__).resolve().parents[2]  # app/api
