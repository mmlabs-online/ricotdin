"""Version served at GET /version.json (ARC-04; same contract as v1 legacy/lib/release/version.ts).

The release tag is never baked into the image: the deployment sets RICOTDIN_VERSION at runtime;
BUILD_COMMIT (baked at build time) is the fallback, then "unknown".
"""

from collections.abc import Mapping


def resolve_version(env: Mapping[str, str]) -> str:
    for key in ("RICOTDIN_VERSION", "BUILD_COMMIT"):
        value = env.get(key, "").strip()
        if value:
            return value
    return "unknown"
