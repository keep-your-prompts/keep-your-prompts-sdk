"""Prompt metadata, metadata maps and the observer hook (``protocol/tracing.md``).

No dependency on OpenTelemetry: :mod:`keepyourprompts.otel` builds on these.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple, Union

AttrValue = Union[str, int]
SOURCES = ("embedded", "snapshot", "cache", "cdn", "origin", "git")


def normalize_source(name: str, kind: str) -> str:
    """Mirror name and kind (``embedded``, ``file``, ``cache``, ``http``) to ``kyp.source``."""
    if not name:
        return ""
    if name == "disk-cache":
        return "cache"
    if name in SOURCES:
        return name
    return {"embedded": "embedded", "cache": "cache", "file": "snapshot"}.get(kind, "custom")


_HTTP = re.compile(r"http (\d{3})\b")


def classify_error(message: str) -> str:
    """A failure message to a low-cardinality ``error.type``."""
    m = message.lower()
    if re.search(r"blob \S+ unavailable", m):
        return "blob_unavailable"
    if "sha256 verification" in m or "hash mismatch" in m:
        return "hash_mismatch"
    if "stale manifest" in m:
        return "stale"
    if "bad manifest" in m or "invalid manifest" in m:
        return "bad_manifest"
    if re.search(r"http (404|410)\b", m) or "not found" in m or "no such file" in m or "not embedded" in m:
        return "not_found"
    h = _HTTP.search(m)
    if h:
        return "http_" + h.group(1)
    if "timed out" in m or "timeout" in m or "deadline" in m:
        return "timeout"
    if re.search(r"urlopen|connection|network|socket|name or service|refused|unreachable|resolve", m):
        return "network"
    return "_OTHER"


@dataclass(frozen=True)
class PromptMeta:
    """Which deployed body a call used. See :meth:`Client.meta`."""

    name: str
    version: int
    sha256: str
    app: str
    env: str
    workspace: str
    revision: int
    source: str  # normalised mirror kind; "" before anything is loaded

    def attributes(self, gen_ai: bool = True) -> Dict[str, AttrValue]:
        """``kyp.*`` (and ``gen_ai.prompt.name``/``gen_ai.prompt.version``) span attributes, as a plain dict."""
        a: Dict[str, AttrValue] = {
            "kyp.prompt.name": self.name,
            "kyp.prompt.version": self.version,
            "kyp.prompt.sha256": self.sha256,
            "kyp.app": self.app,
            "kyp.env": self.env,
            "kyp.revision": self.revision,
        }
        if self.workspace:
            a["kyp.workspace"] = self.workspace
        if self.source:
            a["kyp.source"] = self.source
        if gen_ai:
            a["gen_ai.prompt.name"] = self.name
            a["gen_ai.prompt.version"] = str(self.version)
        return a

    def trace_metadata(self) -> Dict[str, AttrValue]:
        """Flat ``kyp_*`` keys, for any tool's free-form metadata."""
        return {k.replace(".", "_"): v for k, v in self.attributes(gen_ai=False).items()}

    def langfuse_metadata(self) -> Dict[str, AttrValue]:
        """For ``langfuse.update_current_generation(metadata=...)`` and other Langfuse metadata."""
        return self.trace_metadata()

    def langsmith_metadata(self) -> Dict[str, AttrValue]:
        """For ``@traceable(metadata=...)`` / ``langsmith_extra={"metadata": ...}``."""
        return self.trace_metadata()


@dataclass(frozen=True)
class Rendered:
    """What :meth:`Client.render_with_meta` returns."""

    text: str
    meta: PromptMeta

    def __str__(self) -> str:
        return self.text


@dataclass(frozen=True)
class TelemetryEvent:
    name: str  # kyp.fallback, kyp.hash_mismatch or kyp.update
    time_ns: int  # wall clock
    attributes: Dict[str, AttrValue]


@dataclass(frozen=True)
class RefreshRecord:
    """Passed to ``observer.on_refresh`` after each refresh round."""

    app: str
    env: str
    trigger: str  # start, poll or manual
    result: str  # updated, not_modified or failed
    start_time_ns: int  # wall clock
    duration: float  # seconds
    mirror: str  # configured name of the mirror that answered ("" when failed)
    source: str
    revision: int
    previous_revision: int
    workspace: str
    error: str  # when failed, delivery key redacted
    error_type: str
    events: Tuple[TelemetryEvent, ...] = field(default_factory=tuple)


class Observer:
    """Base class for delivery telemetry hooks. Override what you need; exceptions are caught and logged."""

    def on_refresh(self, record: RefreshRecord) -> None:
        pass

    def on_render_error(self, app: str, env: str, name: str, error_type: str) -> None:
        pass


def meta_of(prompt: Any) -> Optional[PromptMeta]:
    """A PromptMeta, or the meta of a Rendered; None for anything else."""
    if isinstance(prompt, PromptMeta):
        return prompt
    if isinstance(prompt, Rendered):
        return prompt.meta
    return None


__all__: List[str] = [
    "Observer",
    "PromptMeta",
    "RefreshRecord",
    "Rendered",
    "TelemetryEvent",
    "classify_error",
    "normalize_source",
]
