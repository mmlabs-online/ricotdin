"""OPS-02: staging releases from staging/X.Y.Z branches (pure guard + naming)."""

import os
import subprocess
import sys
from pathlib import Path

import pytest

from app.ops.staging_release import (
    StagingReleaseError,
    deployment_branch,
    parse_staging_ref,
    read_versions,
    release_env,
    staging_tag,
    version_problems,
)

SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
DIGEST = "sha256:" + "0123456789abcdef" * 4


@pytest.mark.parametrize(
    ("ref", "version"),
    [
        ("refs/heads/staging/2.0.0", "2.0.0"),
        ("staging/2.0.0", "2.0.0"),
        ("refs/heads/staging/2.10.3", "2.10.3"),
        ("staging/12.0.1", "12.0.1"),
    ],
)
def test_staging_ref_gives_the_version(ref: str, version: str) -> None:
    assert parse_staging_ref(ref) == version


@pytest.mark.parametrize(
    "ref",
    [
        "staging/2.0",
        "staging/v2.0.0",
        "staging/2.0.0-rc1",
        "staging/2.0.0/x",
        "staging/1.1.2",  # v1 is never staged by this workflow
        "staging/02.0.0",
        "feature/x",
        "refs/tags/staging/2.0.0",
        "refs/heads/release/2.0",
        "",
    ],
)
def test_other_refs_are_refused(ref: str) -> None:
    with pytest.raises(StagingReleaseError):
        parse_staging_ref(ref)


def test_tag_is_staging_version_and_short_sha() -> None:
    assert staging_tag("2.0.0", SHA) == "staging-2.0.0-a1b2c3d"


@pytest.mark.parametrize("sha", ["a1b2c3d", "x" * 40, SHA.upper(), ""])
def test_tag_needs_a_full_lowercase_commit_sha(sha: str) -> None:
    with pytest.raises(StagingReleaseError):
        staging_tag("2.0.0", sha)


def test_versions_must_all_match_the_branch() -> None:
    assert version_problems("2.0.0", "2.0.0", "2.0.0") == []
    assert version_problems("2.0.1", "2.0.0", "2.0.0") == [
        "app/api/pyproject.toml has version 2.0.0, the branch is staging/2.0.1",
        "app/web/package.json has version 2.0.0, the branch is staging/2.0.1",
    ]
    assert version_problems("2.0.0", None, "2.0.0") == [
        "app/api/pyproject.toml has no version, the branch is staging/2.0.0"
    ]


def test_versions_are_read_from_both_files() -> None:
    pyproject = '[project]\nname = "ricotdin-api"\nversion = "2.0.0"\n\n[tool.x]\nversion = "9"\n'
    package = '{\n  "name": "ricotdin-web",\n  "version": "2.0.0"\n}\n'
    assert read_versions(pyproject, package) == ("2.0.0", "2.0.0")
    assert read_versions("[project]\n", "{}") == (None, None)
    assert read_versions("not toml [", "not json") == (None, None)


def test_deployment_branch_keeps_the_app_folder_readable_by_pr_scope() -> None:
    # pr-scope.yml reads the app from ^release/([a-z0-9-]+)-v[0-9]: here ricotdin-v2-staging
    assert deployment_branch("2.0.0") == "release/ricotdin-v2-staging-v2.0.0"


def test_release_env_pins_both_images_by_digest() -> None:
    text = release_env("staging-2.0.0-a1b2c3d", SHA, api_digest=DIGEST, web_digest=DIGEST)
    lines = text.splitlines()
    assert lines[0].startswith("# Written by the ricotdin staging release workflow")
    assert lines[1:] == [
        f"RICOTDIN_API_IMAGE=mingming21400/ricotdin-api:staging-2.0.0-a1b2c3d@{DIGEST}",
        f"RICOTDIN_WEB_IMAGE=mingming21400/ricotdin-web:staging-2.0.0-a1b2c3d@{DIGEST}",
        "RICOTDIN_VERSION=staging-2.0.0-a1b2c3d",
    ]
    assert text.endswith("\n")


@pytest.mark.parametrize("digest", ["", "sha256:abc", "md5:" + "0" * 64, DIGEST + "\nX=1"])
def test_release_env_refuses_a_bad_digest(digest: str) -> None:
    with pytest.raises(StagingReleaseError):
        release_env("staging-2.0.0-a1b2c3d", SHA, api_digest=digest, web_digest=DIGEST)


def test_release_env_refuses_a_bad_tag() -> None:
    with pytest.raises(StagingReleaseError):
        release_env("v2.0.0", SHA, api_digest=DIGEST, web_digest=DIGEST)


# --- the exact command line of release-staging.yml (review: -I also sets -P since 3.11) -------

API_DIR = Path(__file__).resolve().parents[1]
GUARD = ["-I", "app/ops/staging_release.py"]


def _guard(tmp_path: Path, ref: str, *args: str) -> tuple[int, str, str]:
    out = tmp_path / "github_output"
    out.write_text("", encoding="utf-8")
    env = {
        "GITHUB_REF": ref,
        "GITHUB_SHA": SHA,
        "GITHUB_OUTPUT": str(out),
        "PATH": os.environ.get("PATH", ""),
    }
    if os.name == "nt":
        env["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", "")
    run = subprocess.run(  # noqa: S603 - fixed interpreter and arguments
        [sys.executable, *GUARD, *args],
        cwd=API_DIR,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    return run.returncode, out.read_text(encoding="utf-8"), run.stderr


def test_workflow_guard_writes_its_outputs_for_the_current_version(tmp_path: Path) -> None:
    version = read_versions(
        (API_DIR / "pyproject.toml").read_text(encoding="utf-8"),
        (API_DIR.parent / "web/package.json").read_text(encoding="utf-8"),
    )[0]
    code, outputs, _ = _guard(tmp_path, f"refs/heads/staging/{version}")
    assert code == 0
    assert outputs.splitlines() == [
        f"version={version}",
        f"tag=staging-{version}-a1b2c3d",
        f"branch=release/ricotdin-v2-staging-v{version}",
    ]


@pytest.mark.parametrize(
    "ref", ["refs/heads/staging/2.0", "refs/heads/staging/9.9.9", "refs/heads/feature/x"]
)
def test_workflow_guard_fails_with_an_error_and_no_outputs(tmp_path: Path, ref: str) -> None:
    code, outputs, stderr = _guard(tmp_path, ref)
    assert code == 1
    assert outputs == ""  # nothing a later job could take for a tag
    assert "::error::" in stderr


def test_release_env_command_prints_the_file_and_errors_on_stderr(tmp_path: Path) -> None:
    code, _, stderr = _guard(
        tmp_path, "refs/heads/staging/2.0.0", "release-env", "staging-2.0.0-a1b2c3d", "bad", DIGEST
    )
    assert code == 1
    assert "::error::" in stderr
