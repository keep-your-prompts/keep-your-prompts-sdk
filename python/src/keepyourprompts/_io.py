"""Mirror access: files and HTTP (urllib, standard library only)."""

from __future__ import annotations

import os
import socket
import tempfile
import urllib.error
import urllib.request
from typing import Optional

MAX_BODY = 16 << 20  # 16 MiB: far above any manifest or prompt


class FetchResult:
    __slots__ = ("body", "error", "etag", "kind")

    OK = "ok"
    NOT_MODIFIED = "not_modified"
    NOT_FOUND = "not_found"
    FAILED = "failed"

    def __init__(self, kind: str, body: bytes = b"", etag: str = "", error: str = "") -> None:
        self.kind = kind
        self.body = body
        self.etag = etag
        self.error = error

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "FetchResult(%s, %d bytes, etag=%r, error=%r)" % (self.kind, len(self.body), self.etag, self.error)


def file_url_to_path(url: str) -> str:
    if url.startswith("file://"):
        url = urllib.request.url2pathname(url[7:])
    return url


def read_file(path: str) -> FetchResult:
    try:
        with open(path, "rb") as f:
            return FetchResult(FetchResult.OK, f.read())
    except (FileNotFoundError, NotADirectoryError):
        return FetchResult(FetchResult.NOT_FOUND, error="no such file: %s" % path)
    except OSError as e:
        return FetchResult(FetchResult.FAILED, error="cannot read %s: %s" % (path, e))


def atomic_write(path: str, data: bytes) -> None:
    """Write through a temp file, fsync and rename, so readers never see half a file."""
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=d)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


_opener = urllib.request.build_opener()  # honours HTTPS_PROXY / NO_PROXY


def http_get(
    url: str,
    *,
    etag: str = "",
    token: str = "",
    timeout: float = 5.0,
    user_agent: str = "",
) -> FetchResult:
    if timeout <= 0:
        return FetchResult(FetchResult.FAILED, error="deadline exceeded")
    headers = {"Accept": "*/*"}
    if user_agent:
        headers["User-Agent"] = user_agent
    if etag:
        headers["If-None-Match"] = etag
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, headers=headers)
    try:
        with _opener.open(req, timeout=timeout) as res:
            body = res.read(MAX_BODY + 1)
            if len(body) > MAX_BODY:
                return FetchResult(FetchResult.FAILED, error="response larger than 16 MiB")
            return FetchResult(FetchResult.OK, body, res.headers.get("ETag") or "")
    except urllib.error.HTTPError as e:
        try:
            e.read()
        except Exception:
            pass
        finally:
            e.close()
        if e.code == 304:
            return FetchResult(FetchResult.NOT_MODIFIED, etag=(e.headers.get("ETag") if e.headers else "") or "")
        kind = FetchResult.NOT_FOUND if e.code in (404, 410) else FetchResult.FAILED
        return FetchResult(kind, error="HTTP %d" % e.code)
    except urllib.error.URLError as e:
        reason = e.reason
        if isinstance(reason, socket.timeout):
            return FetchResult(FetchResult.FAILED, error="timed out after %d ms" % (timeout * 1000))
        return FetchResult(FetchResult.FAILED, error=str(reason))
    except (socket.timeout, TimeoutError):
        return FetchResult(FetchResult.FAILED, error="timed out after %d ms" % (timeout * 1000))
    except (OSError, ValueError) as e:
        return FetchResult(FetchResult.FAILED, error=str(e) or e.__class__.__name__)


def post_json(url: str, body: bytes, *, token: str, timeout: float, user_agent: str) -> int:
    """POST ``body``; returns the HTTP status (raises OSError on network failure)."""
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "User-Agent": user_agent,
        },
    )
    try:
        with _opener.open(req, timeout=timeout) as res:
            res.read()
            return int(res.status)
    except urllib.error.HTTPError as e:
        e.close()
        return int(e.code)


def optional_httpx() -> Optional[object]:
    try:
        import httpx  # type: ignore[import-not-found]

        return httpx
    except ImportError:
        return None
