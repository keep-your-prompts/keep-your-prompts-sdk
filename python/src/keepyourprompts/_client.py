"""The synchronous client: a daemon thread keeps prompts fresh; reads never do I/O."""

from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, List, Mapping, Optional, TypeVar

from ._engine import (
    Engine,
    Options,
    Prompt,
    State,
    Status,
    Update,
    _Fetch,
    _jitter,
    _join,
    _redact,
    deliver,
    run_sync,
)
from ._errors import UnavailableError
from ._io import FetchResult, http_get
from ._outcomes import OutcomeBuffer, make_event, send_sync
from ._template import render_template

F = TypeVar("F", bound=Callable[[Update], Any])


class Client:
    """Deployed prompts, read from memory.

    >>> prompts = Client.from_env()            # KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
    >>> prompts.render("triage", company="Acme")

    Construction loads the newest local copy (snapshot folder, disk cache) at once, or
    waits up to ``startup_timeout`` seconds for a network mirror. A daemon thread then
    revalidates every ``poll_interval`` seconds. ``get``/``render``/``prompt`` read an
    immutable state object and are safe from any number of threads.
    """

    def __init__(self, app: str = "", *, options: Optional[Options] = None, **kwargs: Any) -> None:
        if options is None:
            options = Options(app=app, **kwargs)
        elif app or kwargs:
            raise TypeError("pass either options= or keyword arguments, not both")
        self._engine = e = Engine(options)
        self._listeners: List[Callable[[Update], Any]] = []
        if options.on_update is not None:
            self._listeners.append(options.on_update)
        self._lock = threading.Lock()  # one refresh round at a time
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._closed = False
        self._outcomes: Optional[OutcomeBuffer] = (
            OutcomeBuffer(options.outcome_buffer_size) if options.api_key else None
        )
        self._flush_wake = threading.Event()
        self._flusher: Optional[threading.Thread] = None
        self._flush_lock = threading.Lock()

        with self._lock:
            run_sync(e.load_local(), self._fetch)
        loaded_locally = e.state is not None
        if not loaded_locally:
            if not e.polled:
                if not options.start_empty:
                    raise UnavailableError(e.no_mirror_message())
                e.log(30, "starting empty: no mirror for " + e.what)
            else:
                self._startup_from_network()
        if e.polled and options.auto_refresh:
            immediate = loaded_locally or e.state is None
            self._thread = threading.Thread(target=self._run, args=(immediate,), name="kyp-refresh", daemon=True)
            self._thread.start()

    @classmethod
    def from_env(cls, environ: Optional[Mapping[str, str]] = None, **overrides: Any) -> Client:
        """Read ``KYP_*`` from ``os.environ`` (or ``environ``), then apply keyword overrides."""
        return cls(options=Options.from_env(environ, **overrides))

    # --- reads: memory only -------------------------------------------------------
    def get(self, name: str) -> str:
        """The raw template. Raises :class:`NotFoundError`."""
        return self._engine.find(name).text

    def try_get(self, name: str) -> Optional[str]:
        s = self._engine.state
        p = s.prompts.get(name) if s is not None else None
        return p.text if p is not None else None

    def __contains__(self, name: object) -> bool:
        s = self._engine.state
        return s is not None and name in s.prompts

    def prompt(self, name: str) -> Prompt:
        """Name, version, sha256, variables, text and ``render()``. Raises :class:`NotFoundError`."""
        return self._engine.find(name)

    def render(
        self,
        name: str,
        variables: Optional[Mapping[str, Any]] = None,
        /,
        *,
        strict: bool = True,
        on_missing: Optional[str] = None,
        **kwargs: Any,
    ) -> str:
        """``render("triage", company="Acme")`` or ``render("triage", {"company": "Acme"})``.

        Raises :class:`NotFoundError` or :class:`MissingVariableError` (unless ``strict=False``).
        """
        values: Dict[str, Any] = dict(variables) if variables else {}
        values.update(kwargs)
        return render_template(self._engine.find(name).text, values, strict=strict, on_missing=on_missing)

    def names(self) -> List[str]:
        s = self._engine.state
        return list(s.prompts) if s is not None else []

    @property
    def revision(self) -> int:
        s = self._engine.state
        return s.manifest.revision if s is not None else 0

    def status(self) -> Status:
        return self._engine.status()

    def to_snapshot(self) -> Optional[Dict[str, Any]]:
        """The state held now as ``{"kyp": 1, "files": {path: text}}`` (usable as ``embedded_snapshot``)."""
        return self._engine.to_snapshot()

    # --- control ---------------------------------------------------------------
    def on_update(self, callback: F) -> F:
        """Register a callback for new revisions. Usable as a decorator. Called on the refresher thread."""
        self._listeners.append(callback)
        return callback

    def remove_update_listener(self, callback: Callable[[Update], Any]) -> None:
        if callback in self._listeners:
            self._listeners.remove(callback)

    def refresh(self) -> bool:
        """Revalidate now across mirrors, ignoring backoff. Returns True if a mirror answered."""
        e = self._engine
        if not e.polled or self._closed:
            return False
        with self._lock:
            ok = bool(run_sync(e.round(True, float("inf")), self._fetch))
        deliver(e.take_updates(), self._listeners)
        return ok

    def report(
        self,
        prompt: str,
        outcome: str,
        *,
        latency_ms: Optional[float] = None,
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        sha256: Optional[str] = None,
    ) -> None:
        """Record how a call that used ``prompt`` went: ``success``, ``failure``,
        ``feedback_positive`` or ``feedback_negative``. Buffered and sent in the background;
        a no-op without an API key. Never raises."""
        if self._outcomes is None or self._closed:
            return
        try:
            ev = make_event(self._engine, prompt, outcome, latency_ms, input_tokens, output_tokens, sha256)
            if ev is None:
                return
            full = self._outcomes.add(ev)
            self._ensure_flusher()
            if full:
                self._flush_wake.set()
        except Exception:  # fail-silent
            pass

    def flush(self) -> None:
        """Send buffered outcome reports now (blocking). Never raises."""
        if self._outcomes is None:
            return
        with self._flush_lock:
            try:
                send_sync(self._outcomes, self._engine)
            except Exception:
                pass

    def close(self) -> None:
        """Stop the refresher and flush outcome reports. Reads keep working."""
        if self._closed:
            return
        self._closed = True
        self._engine.stopped = True
        self._stop.set()
        self._flush_wake.set()
        for t in (self._thread, self._flusher):
            if t is not None and t is not threading.current_thread():
                t.join(timeout=self._engine.o.request_timeout + 1)
        self.flush()

    def __enter__(self) -> Client:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def __repr__(self) -> str:
        st = self._engine.state
        return "<keepyourprompts.Client %s revision %d>" % (self._engine.what, st.manifest.revision if st else 0)

    # --- internals -------------------------------------------------------------------
    def _fetch(self, op: _Fetch) -> FetchResult:
        e = self._engine
        m = e.mirrors[op.mi]
        if m.kind != "http":
            r = e.read_local(op.mi, op.rel)
        else:
            r = http_get(
                _join(m.url, op.rel),
                etag=op.etag,
                token=m.token,
                timeout=e.timeout_for(op.deadline),
                user_agent=e.o.user_agent,
            )
        if r.error:
            r.error = _redact(r.error, e.key)
        return r

    def _startup_from_network(self) -> None:
        e = self._engine
        timeout = e.o.startup_timeout
        deadline = time.monotonic() + timeout
        delay = 0.1
        while e.state is None:
            with self._lock:
                run_sync(e.round(True, deadline), self._fetch)
            remaining = deadline - time.monotonic()
            if e.state is not None or remaining <= 0.1:
                break
            time.sleep(min(delay, remaining - 0.1))
            delay = min(delay * 2, 1.0)
        e.take_updates()  # the first load is not an "update"
        if e.state is not None:
            return
        if not e.o.start_empty:
            raise UnavailableError(e.unavailable_message(timeout))
        e.log(30, "starting empty, will keep trying: " + e.last_error)

    def _run(self, immediate: bool) -> None:
        e = self._engine
        first = immediate
        while not self._stop.is_set():
            if not first and self._stop.wait(e.o.poll_interval * _jitter()):
                break
            first = False
            with self._lock:
                try:
                    run_sync(e.round(False, float("inf")), self._fetch)
                except Exception as ex:  # never let the refresher die
                    e.log(40, "refresh error: %s" % ex)
            deliver(e.take_updates(), self._listeners)

    def _ensure_flusher(self) -> None:
        if self._flusher is not None:
            return
        with self._flush_lock:
            if self._flusher is None:
                self._flusher = threading.Thread(target=self._flush_loop, name="kyp-outcomes", daemon=True)
                self._flusher.start()

    def _flush_loop(self) -> None:
        interval = self._engine.o.outcome_flush_interval
        while not self._stop.is_set():
            self._flush_wake.wait(interval if interval > 0 else None)
            self._flush_wake.clear()
            if self._stop.is_set():
                break
            self.flush()


__all__ = ["Client", "State"]
