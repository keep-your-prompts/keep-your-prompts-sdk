from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Callable, Dict, Iterator, Optional, Tuple

import pytest

ROOT = Path(__file__).resolve().parents[2]
CONFORMANCE = ROOT / "conformance"
FIXTURES = CONFORMANCE / "fixtures"
KEY = "kypd_Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4f"
GREETING_V4 = "Hello {{name}}, welcome to {{ company }}."
GREETING_V5 = "Hi {{name}}! {{company}} is glad you are here."

_no_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class FakeCdn:
    """conformance/fake_cdn.py as a subprocess."""

    def __init__(self, routes: Dict[str, Tuple[str, Path]]) -> None:
        args = [sys.executable, str(CONFORMANCE / "fake_cdn.py")]
        for name, (prefix, d) in routes.items():
            args += ["--route", "%s:%s:%s" % (name, prefix, d)]
        self.proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        line = self.proc.stdout.readline() if self.proc.stdout else ""
        if not line.startswith("PORT "):
            raise RuntimeError("fake_cdn.py did not start: %r" % line)
        self.port = int(line.split()[1])

    @property
    def base(self) -> str:
        return "http://127.0.0.1:%d" % self.port

    def ctl(self, path: str) -> str:
        with _no_proxy.open(self.base + path, timeout=5) as r:
            return r.read().decode()

    def down(self, route: str) -> None:
        self.ctl("/__down/" + route)

    def up(self, route: str) -> None:
        self.ctl("/__up/" + route)

    def stats(self) -> dict:
        return json.loads(self.ctl("/__stats"))

    def stop(self) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:  # pragma: no cover
            self.proc.kill()
        if self.proc.stdout:
            self.proc.stdout.close()


def routes(cdn: Optional[Path] = None, origin: Optional[Path] = None, git: Optional[Path] = None):
    r: Dict[str, Tuple[str, Path]] = {}
    if cdn:
        r["cdn"] = ("/v1/d/" + KEY, cdn)
    if origin:
        r["origin"] = ("/v1/delivery/" + KEY, origin)
    if git:
        r["git"] = ("/acme/prompts/main/.kyp", git)
    return r


def net_options(s: FakeCdn, **kw):
    o = dict(
        app="demo",
        delivery_key=KEY,
        cdn_url=s.base + "/v1/d",
        origin_url=s.base + "/v1/delivery",
        auto_refresh=False,
    )
    o.update(kw)
    return o


def deploy(name: str, dst: Path) -> Path:
    """Copy (or merge) a fixture like the server deploys: blobs first, then the manifest."""
    src = FIXTURES / name
    (dst / "blobs").mkdir(parents=True, exist_ok=True)
    for b in (src / "blobs").iterdir():
        shutil.copyfile(b, dst / "blobs" / b.name)
    (dst / "envs" / "demo").mkdir(parents=True, exist_ok=True)
    tmp = dst / "envs" / "demo" / "prod.json.new"
    shutil.copyfile(src / "envs" / "demo" / "prod.json", tmp)
    tmp.replace(dst / "envs" / "demo" / "prod.json")
    return dst


@pytest.fixture
def cdn() -> Iterator[Callable[..., FakeCdn]]:
    started = []

    def start(**dirs: Path) -> FakeCdn:
        s = FakeCdn(routes(**dirs))
        started.append(s)
        return s

    yield start
    for s in started:
        s.stop()


def eventually(fn: Callable[[], bool], timeout: float = 5.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if fn():
            return True
        time.sleep(0.02)
    return fn()


def snapshot_of(name: str) -> dict:
    d = FIXTURES / name
    files = {"envs/demo/prod.json": (d / "envs/demo/prod.json").read_text("utf-8")}
    for b in (d / "blobs").iterdir():
        files["blobs/" + b.name] = b.read_text("utf-8")
    return {"kyp": 1, "files": files}
