"""Write the API's OpenAPI document (ARC-04). CI uploads it as an artifact; the web client is
generated from it (ARC-11).

    cd app/api && uv run python -m scripts.dump_openapi [openapi.json]
"""

import json
import sys
from pathlib import Path

from app.core.settings import Settings
from app.main import create_app


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "openapi.json")
    spec = create_app(Settings()).openapi()
    out.write_text(json.dumps(spec, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {out} ({len(spec.get('paths', {}))} paths)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
