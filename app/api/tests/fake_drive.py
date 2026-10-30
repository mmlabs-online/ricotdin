"""A small in-memory Google Drive (OAuth token endpoint + Drive v3 files/upload/permissions/about)
for ``httpx2.MockTransport`` (ARC-17 tests). Only what DriveClient uses."""

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs

import httpx2

from app.services.storage.config import DriveConfig

ROOT = "root-folder-0001"
OWNER = "owner@example.com"
UPLOAD = "https://www.googleapis.com/upload/drive/v3/files"
CONFIG = DriveConfig("cid", "client-secret-XYZ", "1//refresh-ABC", ROOT, OWNER)


@dataclass
class FakeFile:
    meta: dict[str, Any]
    data: bytes = b""


@dataclass
class FakeDrive:
    files: dict[str, FakeFile] = field(default_factory=dict)
    sessions: dict[str, dict[str, Any]] = field(default_factory=dict)
    requests: list[httpx2.Request] = field(default_factory=list)
    fail: list[int] = field(default_factory=list)  # statuses to answer Drive calls with first
    fail_reason: str | None = None
    token_error: str | None = None  # e.g. "invalid_grant"
    token_calls: int = 0
    reject_token: str | None = None  # access token Drive answers 401 for
    permissions: list[dict[str, Any]] = field(
        default_factory=lambda: [{"type": "user", "role": "owner", "emailAddress": OWNER}]
    )
    deleted: list[str] = field(default_factory=list)
    _n: int = 0

    def transport(self) -> httpx2.MockTransport:
        return httpx2.MockTransport(self.handle)

    def add_file(self, data: bytes, **meta: Any) -> str:
        self._n += 1
        fid = f"file-{self._n:08d}-abc"
        m = {
            "id": fid,
            "name": meta.get("key", "x"),
            "mimeType": "audio/webm",
            "size": str(len(data)),
            "parents": [ROOT],
            "appProperties": {"key": meta.get("key", "x")},
            "md5Checksum": hashlib.md5(data, usedforsecurity=False).hexdigest(),
            "trashed": False,
        }
        m.update({k: v for k, v in meta.items() if k != "key"})
        self.files[fid] = FakeFile(m, data)
        return fid

    def drive_requests(self) -> list[httpx2.Request]:
        return [r for r in self.requests if r.url.host == "www.googleapis.com"]

    # --- handler ---------------------------------------------------------------------------------

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if request.url.host == "oauth2.googleapis.com":
            return self._token(request)
        if self.fail:
            status = self.fail.pop(0)
            body = {"error": {"code": status, "errors": [{"reason": self.fail_reason or "x"}]}}
            return httpx2.Response(status, json=body)
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer at-") or auth == f"Bearer {self.reject_token}":
            return httpx2.Response(401, json={"error": {"code": 401}})
        path = request.url.path
        if path == "/upload/drive/v3/files" and request.method == "POST":
            return self._start_session(request)
        if path == "/upload/drive/v3/files" and request.method == "PUT":
            return self._put_chunk(request)
        if path == "/drive/v3/about":
            return httpx2.Response(
                200, json={"storageQuota": {"limit": "5497558138880", "usage": "1024"}}
            )
        m = re.fullmatch(r"/drive/v3/files/([^/]+)(/permissions)?", path)
        if not m:
            return httpx2.Response(400)
        fid, perms = m.group(1), m.group(2)
        f = self.files.get(fid)
        if f is None:
            return httpx2.Response(404, json={"error": {"code": 404}})
        if perms:
            return httpx2.Response(200, json={"permissions": self.permissions})
        if request.method == "DELETE":
            del self.files[fid]
            self.deleted.append(fid)
            return httpx2.Response(204)
        if request.url.params.get("alt") == "media":
            return self._media(request, f)
        return httpx2.Response(200, json=f.meta)

    def _token(self, request: httpx2.Request) -> httpx2.Response:
        self.token_calls += 1
        form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
        if self.token_error:
            return httpx2.Response(
                400, json={"error": self.token_error, "error_description": "Token revoked"}
            )
        assert form["grant_type"] == "refresh_token"
        assert form["refresh_token"] == CONFIG.refresh_token
        assert form["client_secret"] == CONFIG.client_secret
        return httpx2.Response(
            200, json={"access_token": f"at-{self.token_calls}", "expires_in": 3599}
        )

    def _start_session(self, request: httpx2.Request) -> httpx2.Response:
        body = json.loads(request.content)
        sid = f"S{len(self.sessions) + 1}"
        self.sessions[sid] = {
            "meta": body,
            "length": int(request.headers["x-upload-content-length"]),
            "origin": request.headers.get("origin"),
            "data": b"",
        }
        return httpx2.Response(
            200, headers={"Location": f"{UPLOAD}?uploadType=resumable&upload_id={sid}"}
        )

    def _put_chunk(self, request: httpx2.Request) -> httpx2.Response:
        sid = request.url.params["upload_id"]
        s = self.sessions[sid]
        s["data"] += request.content
        if len(s["data"]) < s["length"]:
            return httpx2.Response(308, headers={"Range": f"bytes=0-{len(s['data']) - 1}"})
        meta = s["meta"]
        fid = self.add_file(
            s["data"],
            key=meta["appProperties"]["key"],
            name=meta["name"],
            mimeType=meta["mimeType"],
            parents=meta["parents"],
        )
        return httpx2.Response(200, json={"id": fid})

    def upload_via_session(self, uri: str, data: bytes) -> str:
        """What the browser does: one PUT of the whole file to the session URI."""
        sid = parse_qs(uri.split("?", 1)[1])["upload_id"][0]
        s = self.sessions[sid]
        s["length"] = len(data)  # a lying browser may send another size than declared
        s["data"] = b""
        resp = self._put_chunk(httpx2.Request("PUT", f"{UPLOAD}?upload_id={sid}", content=data))
        return str(resp.json()["id"])

    def _media(self, request: httpx2.Request, f: FakeFile) -> httpx2.Response:
        rng = request.headers.get("range")
        if not rng:
            return httpx2.Response(200, content=f.data)
        m = re.fullmatch(r"bytes=(\d+)-(\d+)", rng)
        assert m, rng
        a, b = int(m.group(1)), int(m.group(2))
        return httpx2.Response(
            206,
            content=f.data[a : b + 1],
            headers={"Content-Range": f"bytes {a}-{b}/{len(f.data)}"},
        )
