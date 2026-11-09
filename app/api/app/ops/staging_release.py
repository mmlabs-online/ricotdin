"""Staging releases from ``staging/X.Y.Z`` branches (OPS-02). Pure, standard library only.

``release-staging.yml`` runs ``python3 -I app/ops/staging_release.py`` (a file, from ``app/api``, no
dependencies installed) as its guard: the branch must be ``staging/X.Y.Z`` (X >= 2) and both
version files must say ``X.Y.Z``. It prints the image tag (``staging-X.Y.Z-<sha7>``) and the
deployment-repo branch for the later steps. ``release_env`` writes the only file the staging
deployment PR changes (``apps/ricotdin-v2-staging/release.env``).

The deployment branch is ``release/ricotdin-v2-staging-vX.Y.Z``: the deployment repo's
``pr-scope.yml`` reads the app folder from ``^release/([a-z0-9-]+)-v[0-9]``, so such a PR may change
only ``apps/ricotdin-v2-staging/`` — never production (``apps/ricotdin-v2/``) or v1
(``apps/ricotdin/``).
"""

import json
import os
import re
import sys
import tomllib
from pathlib import Path

API_IMAGE = "mingming21400/ricotdin-api"
WEB_IMAGE = "mingming21400/ricotdin-web"
APP_DIR = "apps/ricotdin-v2-staging"

_REF = re.compile(r"(?:refs/heads/)?staging/([1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
_SHA = re.compile(r"[0-9a-f]{40}")
_TAG = re.compile(r"staging-[1-9][0-9]*\.[0-9]+\.[0-9]+-[0-9a-f]{7}")
_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


class StagingReleaseError(ValueError):
    """The ref, commit or build output cannot make a staging release."""


def parse_staging_ref(ref: str) -> str:
    """``staging/2.0.0`` (or ``refs/heads/staging/2.0.0``) → ``2.0.0``; v2 and later only."""
    m = _REF.fullmatch(ref)
    if not m or int(m.group(1)) < 2:
        raise StagingReleaseError(f"{ref or '(empty ref)'} is not a staging/X.Y.Z branch (X >= 2)")
    return ".".join(m.groups())


def staging_tag(version: str, sha: str) -> str:
    if not _SHA.fullmatch(sha):
        raise StagingReleaseError("the commit must be a full 40-character lowercase sha")
    return f"staging-{version}-{sha[:7]}"


def deployment_branch(version: str) -> str:
    return f"release/ricotdin-v2-staging-v{version}"


def read_versions(pyproject: str, package_json: str) -> tuple[str | None, str | None]:
    """``[project].version`` of app/api/pyproject.toml and ``version`` of app/web/package.json."""
    api: str | None = None
    web: str | None = None
    try:
        value = tomllib.loads(pyproject).get("project", {}).get("version")
        api = value if isinstance(value, str) else None
    except tomllib.TOMLDecodeError:
        api = None
    try:
        data = json.loads(package_json)
        value = data.get("version") if isinstance(data, dict) else None
        web = value if isinstance(value, str) else None
    except json.JSONDecodeError:
        web = None
    return api, web


def version_problems(version: str, api_version: str | None, web_version: str | None) -> list[str]:
    problems = []
    for path, found in (
        ("app/api/pyproject.toml", api_version),
        ("app/web/package.json", web_version),
    ):
        if found != version:
            has = f"version {found}" if found else "no version"
            problems.append(f"{path} has {has}, the branch is staging/{version}")
    return problems


def release_env(tag: str, sha: str, *, api_digest: str, web_digest: str) -> str:
    """The three pins (both images by digest) + a comment line; nothing else (compose reads every
    key of an --env-file, e.g. COMPOSE_*)."""
    if not _TAG.fullmatch(tag):
        raise StagingReleaseError(f"{tag} is not a staging image tag")
    for name, digest in (("API", api_digest), ("web", web_digest)):
        if not _DIGEST.fullmatch(digest):
            raise StagingReleaseError(f"the {name} image digest is missing or malformed")
    return (
        f"# Written by the ricotdin staging release workflow for {tag} (commit {sha}). "
        "Do not edit by hand.\n"
        f"RICOTDIN_API_IMAGE={API_IMAGE}:{tag}@{api_digest}\n"
        f"RICOTDIN_WEB_IMAGE={WEB_IMAGE}:{tag}@{web_digest}\n"
        f"RICOTDIN_VERSION={tag}\n"
    )


def main(argv: list[str]) -> int:
    """Guard (no argument): check the ref and the versions, then append ``version`` / ``tag`` /
    ``branch`` to ``$GITHUB_OUTPUT`` (only when every check passed, so a failure leaves no tag).
    ``release-env <tag> <api digest> <web digest>``: print the release.env text on stdout.
    Errors go to stderr as ``::error::`` lines (stdout of release-env is captured by the caller).

    Run it as a file, ``python3 -I app/ops/staging_release.py`` from app/api: ``-I`` implies
    ``-P`` (3.11+), so ``-m app.ops...`` would not find the package."""
    ref = os.environ.get("GITHUB_REF", "")
    sha = os.environ.get("GITHUB_SHA", "")
    try:
        if argv[:1] == ["release-env"] and len(argv) == 4:
            print(release_env(argv[1], sha, api_digest=argv[2], web_digest=argv[3]), end="")
            return 0
        if argv:
            raise StagingReleaseError(
                "usage: staging_release [release-env TAG API_DIGEST WEB_DIGEST]"
            )
        version = parse_staging_ref(ref)
        root = Path(__file__).resolve().parents[4]  # app/api/app/ops/<file> → repository root
        api, web = read_versions(
            (root / "app/api/pyproject.toml").read_text(encoding="utf-8"),
            (root / "app/web/package.json").read_text(encoding="utf-8"),
        )
        problems = version_problems(version, api, web)
        if problems:
            for p in problems:
                print(f"::error::{p}", file=sys.stderr)
            return 1
        tag = staging_tag(version, sha)
        outputs = f"version={version}\ntag={tag}\nbranch={deployment_branch(version)}\n"
        target = os.environ.get("GITHUB_OUTPUT")
        if not target:
            raise StagingReleaseError("GITHUB_OUTPUT is not set (run this inside GitHub Actions)")
        with open(target, "a", encoding="utf-8") as fh:
            fh.write(outputs)
        print(outputs, end="")  # for the log
        return 0
    except StagingReleaseError as exc:
        print(f"::error::{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
