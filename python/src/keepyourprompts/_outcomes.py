"""Optional outcome reporting: ``POST {api}/v1/apps/{app}/outcomes``, buffered and fail-silent."""

from __future__ import annotations

import json
import logging
import threading
from collections import deque
from typing import Any, Deque, Dict, List, Optional
from urllib.parse import quote

from ._engine import Engine
from ._io import post_json

OUTCOME_KINDS = ("success", "failure", "feedback_positive", "feedback_negative")
BATCH = 500  # the API accepts at most 500 events per request


def _count(v: Any) -> Optional[int]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    if v != v or v < 0 or v == float("inf"):
        return None
    return round(v)


class OutcomeBuffer:
    """Thread-safe bounded buffer: when full, the oldest events are dropped."""

    def __init__(self, maxlen: int) -> None:
        self._lock = threading.Lock()
        self._events: Deque[Dict[str, Any]] = deque()
        self._max = max(1, int(maxlen))
        self.dropped = 0

    def __len__(self) -> int:
        with self._lock:
            return len(self._events)

    def _trim(self) -> None:
        while len(self._events) > self._max:
            self._events.popleft()
            self.dropped += 1

    def add(self, event: Dict[str, Any]) -> bool:
        """Returns True when a full batch is waiting."""
        with self._lock:
            self._events.append(event)
            self._trim()
            return len(self._events) >= BATCH

    def take(self, n: int = BATCH) -> List[Dict[str, Any]]:
        with self._lock:
            return [self._events.popleft() for _ in range(min(n, len(self._events)))]

    def put_back(self, batch: List[Dict[str, Any]]) -> None:
        with self._lock:
            self._events.extendleft(reversed(batch))
            self._trim()


def make_event(
    engine: Engine,
    prompt: str,
    outcome: str,
    latency_ms: Any = None,
    input_tokens: Any = None,
    output_tokens: Any = None,
    sha256: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    if outcome not in OUTCOME_KINDS:
        engine.log(logging.WARNING, 'report: unknown outcome "%s" (use %s)' % (outcome, ", ".join(OUTCOME_KINDS)))
        return None
    if sha256 is None:
        s = engine.state
        p = s.prompts.get(prompt) if s is not None else None
        if p is None:
            engine.log(logging.DEBUG, 'report: prompt "%s" is not deployed; dropped' % prompt)
            return None
        sha256 = p.sha256
    e: Dict[str, Any] = {"env": engine.env, "prompt": prompt, "sha256": sha256, "outcome": outcome}
    for k, v in (("latencyMs", latency_ms), ("inputTokens", input_tokens), ("outputTokens", output_tokens)):
        c = _count(v)
        if c is not None:
            e[k] = c
    return e


def outcomes_url(api_url: str, app: str) -> str:
    return "%s/v1/apps/%s/outcomes" % (api_url.rstrip("/"), quote(app, safe=""))


def handle_status(buf: OutcomeBuffer, batch: List[Dict[str, Any]], status: int, engine: Engine) -> bool:
    """Returns False when sending should stop for now (batch put back)."""
    if status >= 500 or status == 429:
        buf.put_back(batch)
        engine.log(logging.DEBUG, "outcome report failed, will retry: HTTP %d" % status)
        return False
    if status >= 400:
        buf.dropped += len(batch)
        engine.log(logging.WARNING, "outcome report rejected: HTTP %d (%d events dropped)" % (status, len(batch)))
    return True


def send_sync(buf: OutcomeBuffer, engine: Engine) -> None:
    o = engine.o
    url = outcomes_url(o.api_url, engine.app)
    while True:
        batch = buf.take()
        if not batch:
            return
        try:
            status = post_json(
                url,
                json.dumps(batch).encode("utf-8"),
                token=o.api_key,
                timeout=o.request_timeout,
                user_agent=o.user_agent,
            )
        except Exception as e:  # network down: keep the batch (bounded) for later
            buf.put_back(batch)
            engine.log(logging.DEBUG, "outcome report failed, will retry: %s" % e)
            return
        if not handle_status(buf, batch, status, engine):
            return
