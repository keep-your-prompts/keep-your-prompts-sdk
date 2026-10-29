"""Snapshots: pull the deployed state once and write it as a folder in the protocol layout."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Dict, Mapping

from ._client import Client
from ._io import atomic_write, read_file


@dataclass(frozen=True)
class SnapshotInfo:
    workspace: str
    revision: int
    prompt_count: int
    files_written: int
    source: str


def write_snapshot(snapshot: Mapping[str, Any], out_dir: str) -> int:
    """Write ``{"kyp": 1, "files": {...}}`` to ``out_dir``. Blobs first, then the manifest.
    Returns the number of files written (unchanged files are skipped)."""
    files: Dict[str, str] = dict(snapshot["files"])
    written = 0
    for rel in sorted(files, key=lambda p: p.startswith("envs/")):
        path = os.path.join(out_dir, *rel.split("/"))
        data = files[rel].encode("utf-8")
        existing = read_file(path)
        if existing.kind == "ok" and existing.body == data:
            continue
        atomic_write(path, data)
        written += 1
    return written


def pull_snapshot(out_dir: str, **options: Any) -> SnapshotInfo:
    """Fetch and verify the deployed manifest and blobs from the network mirrors
    (``app``, ``env``, ``delivery_key``, ``git_mirror``, ``mirrors``, … as for :class:`Client`)
    and write them to ``out_dir``."""
    for k in ("cache_dir", "snapshot_dir", "embedded_snapshot"):
        options.pop(k, None)
    options.setdefault("log_level", "error")
    with Client(auto_refresh=False, start_empty=False, **options) as c:
        snap = c.to_snapshot()
        st = c.status()
    assert snap is not None
    n = write_snapshot(snap, out_dir)
    return SnapshotInfo(st.workspace, st.revision, st.prompt_count, n, st.source)
