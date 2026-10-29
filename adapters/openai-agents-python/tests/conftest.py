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
