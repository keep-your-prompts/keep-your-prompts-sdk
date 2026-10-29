"""Real ``keepyourprompts`` clients over snapshot folders written by the tests: no network, no fakes."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from keepyourprompts import Client


def write_snapshot(root: Path, prompts: dict, revision: int) -> None:
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


class Snapshot:
    def __init__(self, root: Path, prompts: dict) -> None:
        self.root = root
        self.revision = 1
        write_snapshot(root, prompts, self.revision)
        self.client = Client(app="demo", snapshot_dir=str(root), auto_refresh=False)

    def deploy(self, prompts: dict) -> None:
        self.revision += 1
        write_snapshot(self.root, prompts, self.revision)
        assert self.client.refresh()


@pytest.fixture
def snapshot(tmp_path):
    made = []

    def make(prompts: dict) -> Snapshot:
        s = Snapshot(tmp_path / f"snap{len(made)}", prompts)
        made.append(s)
        return s

    yield make
    for s in made:
        s.client.close()
