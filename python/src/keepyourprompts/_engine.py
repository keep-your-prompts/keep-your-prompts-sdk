"""The protocol engine shared by :class:`Client` and :class:`AsyncClient`.

The refresh logic is written once, as generators that *yield* the I/O they need
(``_Fetch`` for a mirror read, ``_Call`` for blocking work such as disk-cache
writes). The sync client drives them with urllib on its refresher thread; the
async client drives them with httpx (or urllib in a worker thread). Reads never
touch the engine's I/O: they look at ``engine.state``, an immutable object that
is replaced with one attribute assignment.
"""

from __future__ import annotations

import hashlib
import logging
import os
import random
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from types import MappingProxyType
from typing import (
    Any,
    Callable,
    Dict,
    Generator,
    List,
    Mapping,
    Optional,
    Sequence,
    Tuple,
    Union,
)

from ._errors import KypError, MissingVariableError, NotFoundError
from ._io import FetchResult, atomic_write, file_url_to_path, read_file
from ._manifest import Manifest, is_slug, parse_manifest
from ._telemetry import PromptMeta, RefreshRecord, Rendered, TelemetryEvent, classify_error, normalize_source
from ._template import render_template
from ._version import __version__

log = logging.getLogger("keepyourprompts")
log.addHandler(logging.NullHandler())  # the app decides where logs go

DEFAULT_CDN = "https://cdn.keepyourprompts.com/v1/d"
DEFAULT_ORIGIN = "https://api.keepyourprompts.com/v1/delivery"
DEFAULT_API = "https://api.keepyourprompts.com"


# ---------------------------------------------------------------------------
# Public value types
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Prompt:
    """A deployed prompt. Immutable."""

    name: str
    version: int
    sha256: str
    variables: Tuple[str, ...]
    text: str  # the raw template

    def render(
        self,
        variables: Optional[Mapping[str, Any]] = None,
        /,
        *,
        strict: bool = True,
        on_missing: Optional[str] = None,
        **kwargs: Any,
    ) -> str:
        """``prompt.render(company="Acme")`` or ``prompt.render({"company": "Acme"})``."""
        values = dict(variables or {})
        values.update(kwargs)
        return render_template(self.text, values, strict=strict, on_missing=on_missing)


@dataclass(frozen=True)
class Mirror:
    """A mirror in the protocol layout.

    ``url`` is ``https://…`` (or ``http://``), a directory (``/opt/app/prompts`` or
    ``file:///opt/app/prompts``) or ``embedded:`` for ``embedded_snapshot``.
    ``token`` is sent as ``Authorization: Bearer``.
    """

    name: str
    url: str
    token: str = ""


@dataclass(frozen=True)
class Update:
    """Passed to ``on_update`` callbacks after a new revision was swapped in."""

    old_revision: int  # 0 if nothing was loaded before
    new_revision: int
    source: str  # mirror that delivered it
    changed: Tuple[str, ...]  # prompts added, removed or with a new body


@dataclass(frozen=True)
class MirrorStatus:
    name: str
    url: str  # delivery key redacted
    consecutive_failures: int
    last_error: str
    last_success: Optional[datetime]


@dataclass(frozen=True)
class Status:
    ready: bool  # a manifest is loaded
    source: str  # mirror that served or last confirmed the current state
    revision: int
    workspace: str
    deployed_at: str
    prompt_count: int
    last_success: Optional[datetime]  # last time a polled mirror confirmed the manifest
    last_error: str  # failures in the latest round, e.g. "cdn: HTTP 503"
    stale_for: float  # seconds since last_success (since start-up if never)
    mirrors: Tuple[MirrorStatus, ...] = field(default_factory=tuple)


# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------
@dataclass
class Options:
    app: str = ""
    env: str = "prod"
    delivery_key: str = ""
    workspace: str = ""
    snapshot_dir: Optional[str] = None
    cache_dir: Optional[str] = None
    embedded_snapshot: Optional[Mapping[str, Any]] = None
    git_mirror: Optional[str] = None
    git_token: str = ""
    cdn_url: str = DEFAULT_CDN
    origin_url: str = DEFAULT_ORIGIN
    mirrors: Optional[Sequence[Mirror]] = None
    extra_mirrors: Sequence[Mirror] = ()
    poll_interval: float = 30.0
    request_timeout: float = 5.0
    startup_timeout: float = 3.0
    max_backoff: float = 300.0
    start_empty: bool = False
    auto_refresh: bool = True
    on_update: Optional[Callable[[Update], Any]] = None
    user_agent: str = "kyp-python/" + __version__
    api_key: str = ""
    api_url: str = DEFAULT_API
    outcome_buffer_size: int = 1000
    outcome_flush_interval: float = 10.0
    log_level: Optional[str] = None
    observer: Optional[Any] = None  # delivery telemetry hook (protocol/tracing.md)

    @staticmethod
    def from_env(environ: Optional[Mapping[str, str]] = None, **overrides: Any) -> Options:
        """``KYP_*`` settings from ``os.environ`` (or ``environ``), then ``overrides``."""
        e = os.environ if environ is None else environ

        def get(name: str) -> str:
            return e.get(name, "") or ""

        o = Options(app=get("KYP_APP"))
        for attr, var in (
            ("env", "KYP_ENV"),
            ("delivery_key", "KYP_DELIVERY_KEY"),
            ("workspace", "KYP_WORKSPACE"),
            ("snapshot_dir", "KYP_SNAPSHOT_DIR"),
            ("cache_dir", "KYP_CACHE_DIR"),
            ("git_mirror", "KYP_GIT_MIRROR"),
            ("git_token", "KYP_GIT_TOKEN"),
            ("cdn_url", "KYP_CDN_URL"),
            ("origin_url", "KYP_ORIGIN_URL"),
            ("api_key", "KYP_API_KEY"),
            ("api_url", "KYP_API_URL"),
            ("log_level", "KYP_LOG"),
        ):
            if get(var):
                setattr(o, attr, get(var))
        try:
            secs = float(get("KYP_POLL_INTERVAL") or 0)
            if secs > 0:
                o.poll_interval = secs
        except ValueError:
            pass
        for k, v in overrides.items():
            if not hasattr(o, k):
                raise TypeError("unknown option %r" % k)
            setattr(o, k, v)
        return o


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------
class _Fetch:
    __slots__ = ("deadline", "etag", "mi", "rel")

    def __init__(self, mi: int, rel: str, etag: str, deadline: float) -> None:
        self.mi, self.rel, self.etag, self.deadline = mi, rel, etag, deadline


class _Call:
    """Blocking work (disk writes): run inline by the sync driver, in a thread by the async one."""

    __slots__ = ("args", "fn")

    def __init__(self, fn: Callable[..., Any], *args: Any) -> None:
        self.fn, self.args = fn, args


Op = Union[_Fetch, _Call]
Gen = Generator[Op, Any, Any]


class _MirrorRt:
    __slots__ = (
        "etag",
        "failures",
        "kind",
        "last_error",
        "last_ok",
        "name",
        "retry_at",
        "shown_url",
        "source",
        "token",
        "url",
    )

    def __init__(self, name: str, kind: str, url: str, shown_url: str, token: str) -> None:
        self.name, self.kind, self.url, self.shown_url, self.token = name, kind, url, shown_url, token
        self.source = normalize_source(name, kind)
        self.etag = ""
        self.failures = 0
        self.retry_at = 0.0  # time.monotonic()
        self.last_error = ""
        self.last_ok: Optional[datetime] = None


class State:
    """Immutable once published."""

    __slots__ = ("by_sha", "manifest", "prompts", "raw")

    def __init__(self, manifest: Manifest, raw: bytes, prompts: Dict[str, Prompt], by_sha: Dict[str, str]) -> None:
        self.manifest = manifest
        self.raw = raw
        self.prompts: Mapping[str, Prompt] = MappingProxyType(prompts)
        self.by_sha: Mapping[str, str] = MappingProxyType(by_sha)


def _kind(url: str) -> str:
    if url in ("embedded:", "embedded"):
        return "embedded"
    if re.match(r"(?i)https?://", url):
        return "http"
    return "file"


def _join(base: str, rel: str) -> str:
    return base + rel if base.endswith("/") else base + "/" + rel


def _redact(text: str, key: str) -> str:
    if len(key) < 8:
        return text
    return text.replace(key, key[:9] + "...")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _jitter() -> float:
    return random.uniform(0.9, 1.1)


UPDATED, UNCHANGED, STALE, FAILED = "updated", "unchanged", "stale", "failed"
_LEVELS = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warn": logging.WARNING,
    "warning": logging.WARNING,
    "error": logging.ERROR,
    "off": logging.CRITICAL + 10,
}


class Engine:
    """Mirrors, refresh rounds and the disk cache. Not thread-safe on its own: the
    clients serialise rounds; status fields are guarded by ``status_lock``."""

    def __init__(self, o: Options) -> None:
        if not o.app:
            raise KypError("kyp: app is not set (app= or KYP_APP)")
        o.env = o.env or "prod"
        if not is_slug(o.app):
            raise KypError('kyp: app "%s" is not a slug ([a-z0-9][a-z0-9-]{0,62})' % o.app)
        if not is_slug(o.env):
            raise KypError('kyp: env "%s" is not a slug ([a-z0-9][a-z0-9-]{0,62})' % o.env)
        o.delivery_key = o.delivery_key or ""
        if not re.fullmatch(r"[A-Za-z0-9_-]*", o.delivery_key):
            raise KypError("kyp: the delivery key contains an invalid character")
        o.poll_interval = max(0.1, float(o.poll_interval))
        if o.log_level:
            log.setLevel(_LEVELS.get(o.log_level.lower(), logging.WARNING))
        self.o = o
        self.app, self.env = o.app, o.env
        self.key = o.delivery_key
        if self.key and not self.key.startswith("kypd_"):
            self.log(logging.WARNING, "delivery key does not start with kypd_; check KYP_DELIVERY_KEY")
        self.embedded: Optional[Mapping[str, str]] = None
        if o.embedded_snapshot is not None:
            files = o.embedded_snapshot.get("files") if isinstance(o.embedded_snapshot, Mapping) else None
            if not isinstance(files, Mapping):
                raise KypError('kyp: embedded_snapshot must be {"kyp": 1, "files": {path: text}}')
            self.embedded = files

        self.state: Optional[State] = None
        self.mirrors: List[_MirrorRt] = []
        self.polled: List[int] = []
        self.cache_idx = -1
        self.cache_root = ""
        self.status_lock = threading.Lock()
        self.started = _now()
        self.last_success: Optional[datetime] = None
        self.last_error = ""
        self.source = ""
        self.pending: List[Update] = []
        self.stopped = False
        self.observers: List[Any] = [o.observer] if o.observer is not None else []
        self._events: List[TelemetryEvent] = []  # span events of the round in progress (rounds are serialised)

        if o.mirrors is not None:
            rest = list(o.mirrors)
        else:
            rest = []
            if o.snapshot_dir:
                rest.append(Mirror("snapshot", str(o.snapshot_dir)))
            if self.key:
                rest.append(Mirror("cdn", _join(o.cdn_url or DEFAULT_CDN, self.key)))
                rest.append(Mirror("origin", _join(o.origin_url or DEFAULT_ORIGIN, self.key)))
            if o.git_mirror:
                rest.append(Mirror("git", o.git_mirror, o.git_token or ""))
        rest.extend(o.extra_mirrors or ())

        if self.embedded is not None and not any(_kind(m.url) == "embedded" for m in rest):
            self._add("embedded", "embedded:", "embedded", "")
        cache_added = False
        for m in rest:
            k = _kind(m.url)
            if k == "embedded" and self.embedded is None:
                continue
            if not cache_added and o.cache_dir and k == "http":
                self._add_cache()
                cache_added = True
            self._add(m.name, m.url, k, m.token)
        if not cache_added and o.cache_dir:
            self._add_cache()

        self.polled = [i for i, m in enumerate(self.mirrors) if m.kind == "http"]
        if not self.polled:
            # No network mirrors: poll the file mirrors (a snapshot folder kept
            # fresh by a sidecar or git pull).
            self.polled = [i for i, m in enumerate(self.mirrors) if m.kind == "file"]

    def _add(self, name: str, url: str, kind: str, token: str) -> None:
        self.mirrors.append(_MirrorRt(name, kind, url, _redact(url, self.key), token))

    def _add_cache(self) -> None:
        self.cache_idx = len(self.mirrors)
        self._add("disk-cache", str(self.o.cache_dir), "cache", "")

    @property
    def manifest_path(self) -> str:
        return "envs/%s/%s.json" % (self.app, self.env)

    @property
    def what(self) -> str:
        return "%s/%s" % (self.app, self.env)

    def log(self, level: int, msg: str) -> None:
        if log.isEnabledFor(level):
            log.log(level, "%s", _redact(msg, self.key))

    # --- reads ------------------------------------------------------------------
    def find(self, name: str) -> Prompt:
        return self._find_in(self.state, name)

    def _find_in(self, s: Optional[State], name: str) -> Prompt:
        if s is not None:
            p = s.prompts.get(name)
            if p is not None:
                return p
        raise NotFoundError(
            name,
            "%s revision %d" % (self.what, s.manifest.revision) if s else "nothing loaded for " + self.what,
        )

    def meta_for(self, p: Prompt, s: Optional[State]) -> PromptMeta:
        with self.status_lock:
            src = self.source
        m = next((m for m in self.mirrors if m.name == src), None) if src else None
        return PromptMeta(
            name=p.name,
            version=p.version,
            sha256=p.sha256,
            app=self.app,
            env=self.env,
            workspace=s.manifest.workspace if s is not None else "",
            revision=s.manifest.revision if s is not None else 0,
            source=m.source if m is not None else "",
        )

    def meta(self, name: str) -> PromptMeta:
        s = self.state
        return self.meta_for(self._find_in(s, name), s)

    def render(self, name: str, values: Mapping[str, Any], strict: bool, on_missing: Optional[str]) -> str:
        try:
            return render_template(self.find(name).text, values, strict=strict, on_missing=on_missing)
        except (NotFoundError, MissingVariableError) as e:
            self.render_failed(name, e)
            raise

    def render_with_meta(
        self, name: str, values: Mapping[str, Any], strict: bool, on_missing: Optional[str]
    ) -> Rendered:
        s = self.state
        try:
            p = self._find_in(s, name)
            return Rendered(render_template(p.text, values, strict=strict, on_missing=on_missing), self.meta_for(p, s))
        except (NotFoundError, MissingVariableError) as e:
            self.render_failed(name, e)
            raise

    # --- telemetry --------------------------------------------------------------------
    def render_failed(self, name: str, e: Exception) -> None:
        if not self.observers:
            return
        error_type = "missing_variable" if isinstance(e, MissingVariableError) else "not_found"
        for o in list(self.observers):
            try:
                o.on_render_error(self.app, self.env, name, error_type)
            except Exception:
                log.exception("observer raised")

    def event(self, name: str, attributes: Dict[str, Any]) -> None:
        if self.observers:
            self._events.append(TelemetryEvent(name, time.time_ns(), attributes))

    def fallback(self, mi: int, err: str) -> None:
        m = self.mirrors[mi]
        self.event(
            "kyp.fallback",
            {
                "kyp.mirror": m.name,
                "kyp.source": m.source,
                "error.type": classify_error(err),
                "kyp.error": _redact(err, self.key),
            },
        )

    def begin_round(self) -> Tuple[int, float]:
        self._events = []
        return time.time_ns(), time.monotonic()

    def emit_round(
        self, trigger: str, started: Tuple[int, float], answered_by: int, prev: int, updated: bool, error: str
    ) -> None:
        events, self._events = self._events, []
        if not self.observers:
            return
        s = self.state
        m = self.mirrors[answered_by] if answered_by >= 0 else None
        error_type = ""
        if m is None:
            fb = [e for e in events if e.name == "kyp.fallback"]
            error_type = str(fb[-1].attributes["error.type"]) if fb else classify_error(error)
        rec = RefreshRecord(
            app=self.app,
            env=self.env,
            trigger=trigger,
            result="failed" if m is None else ("updated" if updated else "not_modified"),
            start_time_ns=started[0],
            duration=max(0.0, time.monotonic() - started[1]),
            mirror=m.name if m else "",
            source=m.source if m else "",
            revision=s.manifest.revision if s is not None else 0,
            previous_revision=prev,
            workspace=s.manifest.workspace if s is not None else "",
            error="" if m else _redact(error, self.key),
            error_type=error_type,
            events=tuple(events),
        )
        for o in list(self.observers):
            try:
                o.on_refresh(rec)
            except Exception:
                log.exception("observer raised")

    def status(self) -> Status:
        s = self.state
        with self.status_lock:
            since = self.last_success or self.started
            return Status(
                ready=s is not None,
                source=self.source,
                revision=s.manifest.revision if s else 0,
                workspace=s.manifest.workspace if s else "",
                deployed_at=s.manifest.deployed_at if s else "",
                prompt_count=len(s.prompts) if s else 0,
                last_success=self.last_success,
                last_error=self.last_error,
                stale_for=max(0.0, (_now() - since).total_seconds()),
                mirrors=tuple(
                    MirrorStatus(m.name, m.shown_url, m.failures, m.last_error, m.last_ok) for m in self.mirrors
                ),
            )

    def to_snapshot(self) -> Optional[Dict[str, Any]]:
        s = self.state
        if s is None:
            return None
        files = {self.manifest_path: s.raw.decode("utf-8")}
        for sha, text in s.by_sha.items():
            files["blobs/" + sha] = text
        return {"kyp": 1, "files": files}

    def take_updates(self) -> List[Update]:
        with self.status_lock:
            todo, self.pending = self.pending, []
        return todo

    # --- local mirror access (used by both drivers) -------------------------------
    def read_local(self, mi: int, rel: str) -> FetchResult:
        m = self.mirrors[mi]
        if m.kind == "embedded":
            text = self.embedded.get(rel) if self.embedded is not None else None
            if text is None:
                return FetchResult(FetchResult.NOT_FOUND, error="not embedded: " + rel)
            return FetchResult(FetchResult.OK, text.encode("utf-8") if isinstance(text, str) else bytes(text))
        if m.kind == "cache":
            if not self.cache_root:
                return FetchResult(FetchResult.NOT_FOUND, error="empty")
            return read_file(os.path.join(self.cache_root, *rel.split("/")))
        return read_file(os.path.join(file_url_to_path(m.url), *rel.split("/")))

    def timeout_for(self, deadline: float) -> float:
        t = self.o.request_timeout
        if deadline != float("inf"):
            t = min(t, deadline - time.monotonic())
        return t

    # --- backoff ----------------------------------------------------------------
    def in_backoff(self, mi: int) -> bool:
        with self.status_lock:
            return self.mirrors[mi].retry_at > time.monotonic()

    def record_ok(self, mi: int) -> None:
        with self.status_lock:
            m = self.mirrors[mi]
            recovered = m.failures > 0
            m.failures = 0
            m.retry_at = 0.0
            m.last_error = ""
            m.last_ok = _now()
        if recovered:
            self.log(logging.INFO, m.name + " is answering again")

    def record_fail(self, mi: int, err: str, count: bool) -> None:
        with self.status_lock:
            m = self.mirrors[mi]
            m.last_error = err
            if not count:
                return
            m.failures += 1
            failures = m.failures
            # Skip the mirror for 0, 1, 3, 7, ... poll intervals, capped at max_backoff.
            mult = (1 << min(failures - 1, 20)) - 1
            m.retry_at = time.monotonic() + min(self.o.poll_interval * mult, self.o.max_backoff) * _jitter()
        self.log(logging.WARNING if failures == 1 else logging.DEBUG, "%s: %s" % (m.name, err))

    # --- loading (generators) ---------------------------------------------------------
    def _resolve_blob(self, mi: int, sha: str, deadline: float) -> Gen:
        order = ([self.cache_idx] if self.cache_idx >= 0 else []) + [mi] + list(range(len(self.mirrors)))
        seen = set()
        errors: List[str] = []
        for i in order:
            if i in seen:
                continue
            seen.add(i)
            if self.stopped:
                break
            if i != mi and self.mirrors[i].kind == "http" and self.in_backoff(i):
                continue
            r: FetchResult = yield _Fetch(i, "blobs/" + sha, "", deadline)
            if r.kind != FetchResult.OK:
                if i == mi:
                    errors.append("%s: %s" % (self.mirrors[i].name, r.error))
                continue
            if hashlib.sha256(r.body).hexdigest() != sha:
                msg = "blob %s failed sha256 verification" % sha[:12]
                self.event(
                    "kyp.hash_mismatch",
                    {"kyp.mirror": self.mirrors[i].name, "kyp.source": self.mirrors[i].source, "kyp.blob.sha256": sha},
                )
                self.log(logging.WARNING, "%s: %s (discarded)" % (self.mirrors[i].name, msg))
                errors.append("%s: %s" % (self.mirrors[i].name, msg))
                continue
            try:
                return r.body.decode("utf-8"), ""
            except UnicodeDecodeError:
                errors.append("%s: blob %s is not UTF-8" % (self.mirrors[i].name, sha[:12]))
                continue
        return None, "blob %s unavailable%s" % (sha[:12], " (%s)" % "; ".join(errors) if errors else "")

    def _build(self, mi: int, man: Manifest, raw: bytes, cur: Optional[State], deadline: float) -> Gen:
        prompts: Dict[str, Prompt] = {}
        by_sha: Dict[str, str] = {}
        for name, mp in man.prompts.items():
            if cur is not None and mp.sha256 in cur.by_sha:
                text: Optional[str] = cur.by_sha[mp.sha256]
            else:
                text = by_sha.get(mp.sha256)
            if text is None:
                text, err = yield from self._resolve_blob(mi, mp.sha256, deadline)
                if text is None:
                    return None, err
            by_sha[mp.sha256] = text
            prompts[name] = Prompt(name, mp.version, mp.sha256, mp.variables, text)
        return State(man, raw, prompts, by_sha), ""

    def try_mirror(self, mi: int, cur: Optional[State], use_etag: bool, deadline: float) -> Gen:
        """Returns (outcome, state, etag, missing, err)."""
        etag = self.mirrors[mi].etag if (use_etag and cur is not None) else ""
        r: FetchResult = yield _Fetch(mi, self.manifest_path, etag, deadline)
        if r.kind == FetchResult.NOT_MODIFIED:
            return UNCHANGED, None, r.etag, False, ""
        if r.kind != FetchResult.OK:
            missing = r.kind == FetchResult.NOT_FOUND
            return FAILED, None, "", missing, ("manifest not found (%s)" % r.error) if missing else r.error
        try:
            man = parse_manifest(r.body, self.app, self.env)
        except Exception as e:  # ProtocolError, or JSON with a bad encoding
            return FAILED, None, "", False, "bad manifest: %s" % e
        if cur is not None and man.revision < cur.manifest.revision:
            err = "stale manifest ignored (revision %d < held %d)" % (man.revision, cur.manifest.revision)
            return STALE, None, "", False, err
        if cur is not None and man.revision == cur.manifest.revision:
            return UNCHANGED, None, r.etag, False, ""
        st, err = yield from self._build(mi, man, r.body, cur, deadline)
        if st is None:
            return FAILED, None, "", False, err
        return UPDATED, st, r.etag, False, ""

    def install(self, st: State, mi: int, notify: bool) -> None:
        old = self.state
        self.state = st  # the swap: one reference assignment
        name = self.mirrors[mi].name
        with self.status_lock:
            self.source = name
        n_changed = sum(1 for p in st.prompts.values() if old is None or _sha_of(old, p.name) != p.sha256)
        if old is not None:
            n_changed += sum(1 for n in old.prompts if n not in st.prompts)
        self.event(
            "kyp.update",
            {
                "kyp.revision.previous": old.manifest.revision if old else 0,
                "kyp.revision": st.manifest.revision,
                "kyp.prompts.changed": n_changed,
            },
        )
        self.log(
            logging.INFO,
            "loaded %s revision %d (%d prompts) from %s" % (self.what, st.manifest.revision, len(st.prompts), name),
        )
        if not notify:
            return
        changed = [p.name for p in st.prompts.values() if old is None or _sha_of(old, p.name) != p.sha256]
        if old is not None:
            changed += [n for n in old.prompts if n not in st.prompts]
        with self.status_lock:
            self.pending.append(Update(old.manifest.revision if old else 0, st.manifest.revision, name, tuple(changed)))

    def load_local(self) -> Gen:
        """Start-up step 1: local mirrors only. The highest revision wins; ties go to the earlier mirror."""
        started = self.begin_round()
        yield _Call(self._locate_cache)
        best: Optional[State] = None
        best_mi = -1
        any_local = False
        errs: List[str] = []
        for mi, m in enumerate(self.mirrors):
            if m.kind == "http":
                continue
            any_local = True
            oc, st, _etag, missing, err = yield from self.try_mirror(mi, best, False, float("inf"))
            if oc == UPDATED:
                best, best_mi = st, mi
            elif oc == FAILED and not missing:
                self.record_fail(mi, err, False)
                self.fallback(mi, err)
                errs.append("%s: %s" % (m.name, err))
        if best is not None:
            self.install(best, best_mi, False)
            if best_mi != self.cache_idx:
                yield _Call(self._write_cache, best)
        if any_local:  # only a round when there was something local to read
            self.emit_round("start", started, best_mi, 0, best is not None, "; ".join(errs) or "no local copy")
        else:
            self._events = []

    def round(self, ignore_backoff: bool, deadline: float, trigger: str = "poll") -> Gen:
        """One refresh round over the polled mirrors, in order. Returns True if one answered."""
        started = self.begin_round()
        cur = self.state
        errs: List[str] = []
        skipped: List[int] = []
        result = {"by": -1, "updated": False}

        def attempt(mi: int) -> Gen:
            m = self.mirrors[mi]
            oc, st, etag, _missing, err = yield from self.try_mirror(mi, cur, True, deadline)
            if oc == UPDATED:
                m.etag = etag
                self.install(st, mi, True)
                yield _Call(self._write_cache, st)
                self.record_ok(mi)
                result["by"], result["updated"] = mi, True
                return True
            if oc == UNCHANGED:
                m.etag = etag or m.etag
                self.record_ok(mi)
                if cur is not None:
                    with self.status_lock:
                        self.source = m.name
                result["by"] = mi
                return True
            errs.append("%s: %s" % (m.name, err))
            self.record_fail(mi, err, oc == FAILED)
            self.fallback(mi, err)
            return False

        answered = False
        for mi in self.polled:
            if self.stopped:
                break
            if not ignore_backoff and self.in_backoff(mi):
                skipped.append(mi)
                continue
            answered = yield from attempt(mi)
            if answered:
                break
        # Everything we tried failed: give the mirrors in backoff a chance too.
        if not answered:
            for mi in skipped:
                if self.stopped:
                    break
                answered = yield from attempt(mi)
                if answered:
                    break
        joined = "; ".join(errs)
        with self.status_lock:
            if answered:
                self.last_success = _now()
            self.last_error = "all mirrors backing off" if (not answered and not joined) else joined
        if not answered and not self.stopped:
            self.log(logging.WARNING, "refresh failed, serving what is held: " + joined)
        self.emit_round(
            trigger,
            started,
            int(result["by"]),
            cur.manifest.revision if cur is not None else 0,
            bool(result["updated"]),
            self.last_error,
        )
        return answered

    def unavailable_message(self, timeout: float) -> str:
        with self.status_lock:
            err = self.last_error
        return "kyp: could not load %s within %d ms: %s" % (self.what, int(timeout * 1000), err)

    def no_mirror_message(self) -> str:
        return (
            "kyp: no prompts for %s: no snapshot or disk cache found and no remote mirror configured "
            "(set KYP_DELIVERY_KEY, KYP_SNAPSHOT_DIR or pass embedded_snapshot)" % self.what
        )

    # --- disk cache (blocking; run through _Call) ----------------------------------
    def _cache_root_for(self, workspace: str) -> str:
        return os.path.join(str(self.o.cache_dir), workspace, self.app, self.env)

    def _locate_cache(self) -> None:
        """Finds <cache_dir>/<workspace>/<app>/<env> holding the highest revision."""
        if self.cache_idx < 0 or self.cache_root:
            return
        if self.o.workspace:
            self.cache_root = self._cache_root_for(self.o.workspace)
            return
        try:
            entries = sorted(os.listdir(str(self.o.cache_dir)))
        except OSError:
            return
        best = -1
        for ws in entries:
            root = self._cache_root_for(ws)
            r = read_file(os.path.join(root, "envs", self.app, self.env + ".json"))
            if r.kind != FetchResult.OK:
                continue
            try:
                rev = parse_manifest(r.body, self.app, self.env).revision
            except Exception:
                continue
            if rev > best:
                best, self.cache_root = rev, root

    def _write_cache(self, st: State) -> None:
        if self.cache_idx < 0:
            return
        root = self._cache_root_for(st.manifest.workspace)
        try:
            for sha, text in st.by_sha.items():
                blob = os.path.join(root, "blobs", sha)
                if not os.path.exists(blob):
                    atomic_write(blob, text.encode("utf-8"))
            mpath = os.path.join(root, "envs", self.app, self.env + ".json")
            existing = read_file(mpath)
            if existing.kind == FetchResult.OK:
                if existing.body == st.raw:
                    self.cache_root = root
                    return
                try:
                    if parse_manifest(existing.body, self.app, self.env).revision > st.manifest.revision:
                        return
                except Exception:
                    pass  # overwrite a damaged manifest
            atomic_write(mpath, st.raw)
            self.cache_root = root
        except OSError as e:
            self.log(logging.WARNING, "disk cache write failed: %s" % e)


def _sha_of(state: State, name: str) -> Optional[str]:
    p = state.prompts.get(name)
    return p.sha256 if p else None


def deliver(updates: List[Update], listeners: List[Callable[[Update], Any]]) -> None:
    for u in updates:
        for cb in list(listeners):
            try:
                cb(u)
            except Exception:
                log.exception("on_update callback raised")


def run_sync(gen: Gen, fetch: Callable[[_Fetch], FetchResult]) -> Any:
    """Drive an engine generator with blocking I/O."""
    try:
        op = next(gen)
        while True:
            if isinstance(op, _Fetch):
                res: Any = fetch(op)
            else:
                res = op.fn(*op.args)
            op = gen.send(res)
    except StopIteration as stop:
        return stop.value
