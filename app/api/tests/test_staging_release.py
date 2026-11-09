"""OPS-02: staging releases from staging/X.Y.Z branches (pure guard + naming)."""

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
