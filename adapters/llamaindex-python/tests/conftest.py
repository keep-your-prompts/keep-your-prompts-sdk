"""Real ``keepyourprompts`` clients over the shared conformance fixtures: no network, no fakes."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from keepyourprompts import Client

FIXTURES = Path(__file__).resolve().parents[3] / "conformance" / "fixtures"
CASES = json.loads((FIXTURES.parent / "cases.json").read_text(encoding="utf-8"))


@pytest.fixture
def prompts():
    c = Client(app="demo", snapshot_dir=str(FIXTURES / "v12"), auto_refresh=False)
    yield c
    c.close()


class Live:
    def __init__(self, tmp: Path) -> None:
        self.dir = tmp / "snapshot"
        shutil.copytree(FIXTURES / "v12", self.dir)
        self.client = Client(app="demo", snapshot_dir=str(self.dir), auto_refresh=False)

    def deploy(self, fixture: str) -> None:
        shutil.copytree(FIXTURES / fixture, self.dir, dirs_exist_ok=True)
        assert self.client.refresh()


@pytest.fixture
def live(tmp_path):
    lv = Live(tmp_path)
    yield lv
    lv.client.close()


def write_snapshot(root: Path, prompts: dict, revision: int) -> None:
    import hashlib

    (root / "envs" / "demo").mkdir(parents=True, exist_ok=True)
    (root / "blobs").mkdir(parents=True, exist_ok=True)
    manifest = {}
    for name, (text, version) in prompts.items():
        data = text.encode("utf-8")
        sha = hashlib.sha256(data).hexdigest()
        (root / "blobs" / sha).write_bytes(data)
        manifest[name] = {"sha256": sha, "version": version, "variables": []}
    doc = {"schema": 1, "workspace": "acme", "app": "demo", "env": "prod", "revision": revision}
    doc.update(deployed_at="2026-10-29T09:00:00Z", prompts=manifest)
    (root / "envs" / "demo" / "prod.json").write_text(json.dumps(doc), encoding="utf-8")


RAG = {
    "rag/answer": ("Context:\n{{context_str}}\nAnswer {{query_str}} for {{company}}. Use {json} as is.", 1),
    "rag/no-context": ("Answer {{query_str}}.", 1),
}


class Snap:
    def __init__(self, root: Path, prompts: dict) -> None:
        self.root, self.revision = root, 1
        write_snapshot(root, prompts, 1)
        self.client = Client(app="demo", snapshot_dir=str(root), auto_refresh=False)

    def deploy(self, prompts: dict) -> None:
        self.revision += 1
        write_snapshot(self.root, prompts, self.revision)
        assert self.client.refresh()


@pytest.fixture
def rag(tmp_path):
    s = Snap(tmp_path / "rag", RAG)
    yield s
    s.client.close()
