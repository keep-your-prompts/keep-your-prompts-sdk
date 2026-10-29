"""The asyncio client. Same surface as :class:`Client`; I/O runs on the event loop
(httpx when installed: ``pip install "keepyourprompts[httpx]"``) and reads never await."""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import time
from typing import Any, Callable, Dict, Generator, List, Mapping, Optional, TypeVar, Union

from ._engine import Engine, Gen, Options, Prompt, Status, Update, _Fetch, _jitter, _join, _redact
from ._errors import UnavailableError
from ._io import MAX_BODY, FetchResult, http_get, optional_httpx, post_json
from ._outcomes import OutcomeBuffer, handle_status, make_event, outcomes_url
from ._telemetry import PromptMeta, Rendered

F = TypeVar("F", bound=Callable[[Update], Any])


class AsyncClient:
    """Deployed prompts for asyncio apps.

    >>> prompts = await AsyncClient.from_env()
    >>> async with AsyncClient(app="support-bot", delivery_key=key) as prompts:
    ...     system = prompts.render("triage", company="Acme")   # no await: memory only

    The client starts on ``await`` (or ``async with``); a background task revalidates
    every ``poll_interval`` seconds. ``close()`` stops it.
    """

    def __init__(self, app: str = "", *, options: Optional[Options] = None, **kwargs: Any) -> None:
        if options is None:
            options = Options(app=app, **kwargs)
        elif app or kwargs:
            raise TypeError("pass either options= or keyword arguments, not both")
        self._engine = Engine(options)
        self._listeners: List[Callable[[Update], Any]] = []
        if options.on_update is not None:
            self._listeners.append(options.on_update)
        self._lock: Optional[asyncio.Lock] = None
        self._task: Optional[asyncio.Task[None]] = None
        self._flusher: Optional[asyncio.Task[None]] = None
        self._started = False
        self._closed = False
        self._http: Any = None
        self._outcomes: Optional[OutcomeBuffer] = (
            OutcomeBuffer(options.outcome_buffer_size) if options.api_key else None
        )
        self._flush_event: Optional[asyncio.Event] = None

    @classmethod
    def from_env(cls, environ: Optional[Mapping[str, str]] = None, **overrides: Any) -> AsyncClient:
        """A client configured from ``KYP_*``. Await it (or use ``async with``) to start it."""
        return cls(options=Options.from_env(environ, **overrides))

    @classmethod
    async def create(cls, app: str = "", **kwargs: Any) -> AsyncClient:
        return await cls(app, **kwargs).start()

    def __await__(self) -> Generator[Any, None, AsyncClient]:
        return self.start().__await__()

    async def __aenter__(self) -> AsyncClient:
        return await self.start()

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    async def start(self) -> AsyncClient:
        """Load prompts (local copies first) and start the refresher. Idempotent."""
        if self._started:
            return self
        self._started = True
        e = self._engine
        self._lock = asyncio.Lock()
        self._flush_event = asyncio.Event()
        httpx = optional_httpx()
        if httpx is not None and (any(m.kind == "http" for m in e.mirrors) or self._outcomes is not None):
            self._http = httpx.AsyncClient(follow_redirects=True, trust_env=True)  # type: ignore[attr-defined]
        try:
            async with self._lock:
                await self._drive(e.load_local())
            loaded_locally = e.state is not None
            if not loaded_locally:
                if not e.polled:
                    if not e.o.start_empty:
                        raise UnavailableError(e.no_mirror_message())
                    e.log(logging.WARNING, "starting empty: no mirror for " + e.what)
                else:
                    await self._startup_from_network()
        except BaseException:
            await self._close_http()
            raise
        if e.polled and e.o.auto_refresh:
            self._task = asyncio.ensure_future(self._run(loaded_locally or e.state is None))
        return self

    # --- reads: memory only (no await) --------------------------------------------
    def get(self, name: str) -> str:
        return self._engine.find(name).text

    def try_get(self, name: str) -> Optional[str]:
        s = self._engine.state
        p = s.prompts.get(name) if s is not None else None
        return p.text if p is not None else None

    def __contains__(self, name: object) -> bool:
        s = self._engine.state
        return s is not None and name in s.prompts

    def prompt(self, name: str) -> Prompt:
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
        values: Dict[str, Any] = dict(variables) if variables else {}
        values.update(kwargs)
        return self._engine.render(name, values, strict, on_missing)

    def meta(self, name: str) -> PromptMeta:
        """Which deployed body ``name`` is (name, version, sha256, app, env, workspace, revision, source).

        Memory only. Raises :class:`NotFoundError`."""
        return self._engine.meta(name)

    def render_with_meta(
        self,
        name: str,
        variables: Optional[Mapping[str, Any]] = None,
        /,
        *,
        strict: bool = True,
        on_missing: Optional[str] = None,
        **kwargs: Any,
    ) -> Rendered:
        """Like :meth:`render`, plus the :class:`PromptMeta` of the exact body rendered: ``r.text``, ``r.meta``."""
        values: Dict[str, Any] = dict(variables) if variables else {}
        values.update(kwargs)
        return self._engine.render_with_meta(name, values, strict, on_missing)

    def add_observer(self, observer: Any) -> Callable[[], None]:
        """Subscribe to delivery telemetry (``on_refresh``, ``on_render_error``; see :class:`Observer`).

        Returns a function that unsubscribes."""
        obs = self._engine.observers
        obs.append(observer)

        def remove() -> None:
            if observer in obs:
                obs.remove(observer)

        return remove

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
        return self._engine.to_snapshot()

    # --- control -----------------------------------------------------------------
    def on_update(self, callback: F) -> F:
        """Register a callback (plain function or coroutine function) for new revisions."""
        self._listeners.append(callback)
        return callback

    def remove_update_listener(self, callback: Callable[[Update], Any]) -> None:
        if callback in self._listeners:
            self._listeners.remove(callback)

    async def refresh(self) -> bool:
        """Revalidate now across mirrors, ignoring backoff. Returns True if a mirror answered."""
        e = self._engine
        if not e.polled or self._closed or self._lock is None:
            return False
        async with self._lock:
            ok = bool(await self._drive(e.round(True, float("inf"), "manual")))
        await self._deliver()
        return ok

    def report(
        self,
        prompt: Union[str, PromptMeta, Rendered],
        outcome: str,
        *,
        latency_ms: Optional[float] = None,
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        sha256: Optional[str] = None,
    ) -> None:
        """Same as :meth:`Client.report`; does not block. Never raises."""
        if self._outcomes is None or self._closed:
            return
        try:
            ev = make_event(self._engine, prompt, outcome, latency_ms, input_tokens, output_tokens, sha256)
            if ev is None:
                return
            full = self._outcomes.add(ev)
            if self._flusher is None and self._started:
                self._flusher = asyncio.ensure_future(self._flush_loop())
            if full and self._flush_event is not None:
                self._flush_event.set()
        except Exception:
            pass

    async def flush(self) -> None:
        """Send buffered outcome reports now. Never raises."""
        buf = self._outcomes
        if buf is None:
            return
        e = self._engine
        url = outcomes_url(e.o.api_url, e.app)
        while True:
            batch = buf.take()
            if not batch:
                return
            body = json.dumps(batch).encode("utf-8")
            try:
                if self._http is not None:
                    res = await self._http.post(
                        url,
                        content=body,
                        headers={
                            "Authorization": "Bearer " + e.o.api_key,
                            "Content-Type": "application/json",
                            "User-Agent": e.o.user_agent,
                        },
                        timeout=e.o.request_timeout,
                    )
                    status = res.status_code
                else:
                    status = await asyncio.to_thread(
                        post_json, url, body, token=e.o.api_key, timeout=e.o.request_timeout, user_agent=e.o.user_agent
                    )
            except Exception as ex:
                buf.put_back(batch)
                e.log(logging.DEBUG, "outcome report failed, will retry: %s" % ex)
                return
            if not handle_status(buf, batch, status, e):
                return

    async def close(self) -> None:
        """Stop the refresher, flush outcome reports and close the HTTP client. Reads keep working."""
        if self._closed:
            return
        self._closed = True
        self._engine.stopped = True
        for t in (self._task, self._flusher):
            if t is not None and not t.done():
                t.cancel()
                try:
                    await t
                except (asyncio.CancelledError, Exception):
                    pass
        await self.flush()
        await self._close_http()

    def __repr__(self) -> str:
        st = self._engine.state
        return "<keepyourprompts.AsyncClient %s revision %d>" % (
            self._engine.what,
            st.manifest.revision if st else 0,
        )

    # --- internals ------------------------------------------------------------------
    async def _close_http(self) -> None:
        if self._http is not None:
            try:
                await self._http.aclose()
            except Exception:
                pass
            self._http = None

    async def _drive(self, gen: Gen) -> Any:
        try:
            op = next(gen)
            while True:
                if isinstance(op, _Fetch):
                    res: Any = await self._fetch(op)
                else:
                    res = await asyncio.to_thread(op.fn, *op.args)
                op = gen.send(res)
        except StopIteration as stop:
            return stop.value

    async def _fetch(self, op: _Fetch) -> FetchResult:
        e = self._engine
        m = e.mirrors[op.mi]
        if m.kind != "http":
            r = e.read_local(op.mi, op.rel)  # small local reads
        else:
            url = _join(m.url, op.rel)
            timeout = e.timeout_for(op.deadline)
            if self._http is None:
                r = await asyncio.to_thread(
                    http_get, url, etag=op.etag, token=m.token, timeout=timeout, user_agent=e.o.user_agent
                )
            else:
                r = await self._httpx_get(url, op.etag, m.token, timeout)
        if r.error:
            r.error = _redact(r.error, e.key)
        return r

    async def _httpx_get(self, url: str, etag: str, token: str, timeout: float) -> FetchResult:
        if timeout <= 0:
            return FetchResult(FetchResult.FAILED, error="deadline exceeded")
        headers = {"User-Agent": self._engine.o.user_agent}
        if etag:
            headers["If-None-Match"] = etag
        if token:
            headers["Authorization"] = "Bearer " + token
        try:
            res = await self._http.get(url, headers=headers, timeout=timeout)
        except Exception as ex:
            name = type(ex).__name__
            if "Timeout" in name:
                return FetchResult(FetchResult.FAILED, error="timed out after %d ms" % (timeout * 1000))
            return FetchResult(FetchResult.FAILED, error="%s: %s" % (name, ex) if str(ex) else name)
        tag = res.headers.get("etag") or ""
        if res.status_code == 304:
            return FetchResult(FetchResult.NOT_MODIFIED, etag=tag)
        if not 200 <= res.status_code <= 299:
            kind = FetchResult.NOT_FOUND if res.status_code in (404, 410) else FetchResult.FAILED
            return FetchResult(kind, error="HTTP %d" % res.status_code)
        if len(res.content) > MAX_BODY:
            return FetchResult(FetchResult.FAILED, error="response larger than 16 MiB")
        return FetchResult(FetchResult.OK, res.content, tag)

    async def _deliver(self) -> None:
        for u in self._engine.take_updates():
            for cb in list(self._listeners):
                try:
                    r = cb(u)
                    if inspect.isawaitable(r):
                        await r
                except Exception:
                    logging.getLogger("keepyourprompts").exception("on_update callback raised")

    async def _startup_from_network(self) -> None:
        e = self._engine
        timeout = e.o.startup_timeout
        deadline = time.monotonic() + timeout
        delay = 0.1
        assert self._lock is not None
        while e.state is None:
            async with self._lock:
                await self._drive(e.round(True, deadline, "start"))
            remaining = deadline - time.monotonic()
            if e.state is not None or remaining <= 0.1:
                break
            await asyncio.sleep(min(delay, remaining - 0.1))
            delay = min(delay * 2, 1.0)
        e.take_updates()  # the first load is not an "update"
        if e.state is not None:
            return
        if not e.o.start_empty:
            raise UnavailableError(e.unavailable_message(timeout))
        e.log(logging.WARNING, "starting empty, will keep trying: " + e.last_error)

    async def _run(self, immediate: bool) -> None:
        e = self._engine
        assert self._lock is not None
        first = immediate
        while not self._closed:
            if not first:
                await asyncio.sleep(e.o.poll_interval * _jitter())
            first = False
            try:
                async with self._lock:
                    await self._drive(e.round(False, float("inf"), "poll"))
            except asyncio.CancelledError:
                raise
            except Exception as ex:
                e.log(logging.ERROR, "refresh error: %s" % ex)
            await self._deliver()

    async def _flush_loop(self) -> None:
        interval = self._engine.o.outcome_flush_interval
        assert self._flush_event is not None
        while not self._closed:
            try:
                await asyncio.wait_for(self._flush_event.wait(), interval if interval > 0 else None)
            except asyncio.TimeoutError:
                pass
            self._flush_event.clear()
            await self.flush()
