"""OpenTelemetry for Keep Your Prompts (``protocol/tracing.md``). Needs ``pip install keepyourprompts[otel]``.

    from keepyourprompts.otel import instrument

    otel = instrument(prompts)          # kyp.refresh spans + kyp.* metrics
    with tracer.start_as_current_span("chat triage"):
        r = prompts.render_with_meta("triage", company="Acme")
        otel.annotate(r)                # kyp.* + gen_ai.prompt.* on the current span

Only this module imports ``opentelemetry``; the rest of the SDK has no dependency on it.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, Iterable, Mapping, Optional, Union

from opentelemetry import context as otel_context
from opentelemetry import metrics, trace
from opentelemetry.metrics import CallbackOptions, Observation
from opentelemetry.trace import SpanKind, Status, StatusCode

from ._telemetry import Observer, PromptMeta, RefreshRecord, Rendered
from ._version import __version__

SCOPE = "keepyourprompts"
"""Instrumentation scope (tracer and meter name), the same in every SDK."""
REFRESH_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0)

log = logging.getLogger("keepyourprompts")


def _env_capture() -> bool:
    return os.environ.get("KYP_OTEL_CAPTURE_CONTENT", "").strip().lower() in ("1", "true", "yes", "on")


def _stringify(v: Any) -> str:
    if isinstance(v, str):
        return v
    if v is None:
        return ""
    if isinstance(v, (dict, list, tuple)):
        try:
            return json.dumps(v, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            return str(v)
    return str(v)


def _apply(
    meta: PromptMeta,
    span: Optional[trace.Span],
    *,
    capture: bool,
    variables: Optional[Mapping[str, Any]],
    template: Optional[str],
    gen_ai_attributes: bool,
    open_inference: bool,
) -> None:
    try:
        if span is None or not span.is_recording():
            return
        a: Dict[str, Any] = dict(meta.attributes(gen_ai=gen_ai_attributes))
        if open_inference:
            a["prompt.vendor"] = "keepyourprompts"
            a["prompt.id"] = "%s/%s/%s" % (meta.app, meta.env, meta.name)
            a["llm.prompt_template.version"] = str(meta.version)
        if capture:
            if template is not None:
                a["kyp.prompt.template"] = template
                if open_inference:
                    a["llm.prompt_template.template"] = template
            if variables:
                vs = {str(k): _stringify(v) for k, v in variables.items()}
                for k, v in vs.items():
                    a["gen_ai.prompt.variable." + k] = v
                if open_inference:
                    a["llm.prompt_template.variables"] = json.dumps(vs, ensure_ascii=False)
        span.set_attributes(a)
    except Exception:  # telemetry never breaks the app
        log.debug("annotate failed", exc_info=True)


def _meta(prompt: Union[PromptMeta, Rendered]) -> PromptMeta:
    if isinstance(prompt, Rendered):
        return prompt.meta
    if isinstance(prompt, PromptMeta):
        return prompt
    raise TypeError("annotate() takes a PromptMeta or a Rendered (from render_with_meta)")


def annotate(
    prompt: Union[PromptMeta, Rendered],
    *,
    span: Optional[trace.Span] = None,
    variables: Optional[Mapping[str, Any]] = None,
    template: Optional[str] = None,
    capture_content: Optional[bool] = None,
    gen_ai_attributes: bool = True,
    open_inference: bool = False,
) -> PromptMeta:
    """Annotate ``span`` (default: the current span) with a prompt's metadata, without a client.

    ``kyp.prompt.template`` needs ``template``; :meth:`Instrumentation.annotate` fills it in for you.
    """
    meta = _meta(prompt)
    _apply(
        meta,
        span if span is not None else trace.get_current_span(),
        capture=_env_capture() if capture_content is None else capture_content,
        variables=variables,
        template=template,
        gen_ai_attributes=gen_ai_attributes,
        open_inference=open_inference,
    )
    return meta


class Instrumentation(Observer):
    """Returned by :func:`instrument`. Records spans and metrics; ``annotate`` marks LLM spans."""

    def __init__(
        self,
        client: Any,
        *,
        tracer_provider: Optional[trace.TracerProvider] = None,
        meter_provider: Optional[metrics.MeterProvider] = None,
        capture_content: Optional[bool] = None,
        gen_ai_attributes: bool = True,
        open_inference: bool = False,
        trace_all_refreshes: bool = False,
    ) -> None:
        self._client = client
        self._capture = _env_capture() if capture_content is None else capture_content
        self._gen_ai = gen_ai_attributes
        self._oi = open_inference
        self._trace_all = trace_all_refreshes
        self._active = True
        self._tracer = trace.get_tracer(SCOPE, __version__, tracer_provider=tracer_provider)
        meter = metrics.get_meter(SCOPE, __version__, meter_provider=meter_provider)
        e = client._engine
        self._base = {"kyp.app": e.app, "kyp.env": e.env}
        try:
            self._duration = meter.create_histogram(
                "kyp.refresh.duration",
                unit="s",
                description="Wall time of each prompt refresh round.",
                explicit_bucket_boundaries_advisory=list(REFRESH_BUCKETS),
            )
        except TypeError:  # opentelemetry-api older than 1.23
            self._duration = meter.create_histogram(
                "kyp.refresh.duration", unit="s", description="Wall time of each prompt refresh round."
            )
        self._fallbacks = meter.create_counter(
            "kyp.fallbacks", unit="{fallback}", description="Mirror failures that made a refresh move on."
        )
        self._mismatches = meter.create_counter(
            "kyp.hash_mismatches", unit="{blob}", description="Prompt bodies discarded: SHA-256 mismatch."
        )
        self._render_errors = meter.create_counter(
            "kyp.render.errors", unit="{error}", description="render() failures: unknown prompt or missing variable."
        )
        meter.create_observable_gauge(
            "kyp.staleness",
            callbacks=[self._observe_staleness],
            unit="s",
            description="Seconds since a mirror last confirmed the prompts held.",
        )
        meter.create_observable_gauge(
            "kyp.revision",
            callbacks=[self._observe_revision],
            unit="{revision}",
            description="Manifest revision held (0 when nothing is loaded).",
        )
        self._unsubscribe = client.add_observer(self)

    # --- annotate -------------------------------------------------------------------
    def annotate(
        self,
        prompt: Union[str, PromptMeta, Rendered],
        *,
        span: Optional[trace.Span] = None,
        variables: Optional[Mapping[str, Any]] = None,
        capture_content: Optional[bool] = None,
    ) -> PromptMeta:
        """Set ``kyp.*`` and ``gen_ai.prompt.*`` on ``span`` (default: the current span). Returns the metadata.

        ``prompt`` is a name (the body held now), a :class:`PromptMeta` or a :class:`Rendered`.
        Raises :class:`NotFoundError` for an unknown name, never for telemetry reasons."""
        meta = self._client.meta(prompt) if isinstance(prompt, str) else _meta(prompt)
        capture = self._capture if capture_content is None else capture_content
        template = None
        if capture:
            s = self._client._engine.state
            p = s.prompts.get(meta.name) if s is not None else None
            if p is not None and p.sha256 == meta.sha256:  # only the very body the metadata names
                template = p.text
        _apply(
            meta,
            span if span is not None else trace.get_current_span(),
            capture=capture,
            variables=variables,
            template=template,
            gen_ai_attributes=self._gen_ai,
            open_inference=self._oi,
        )
        return meta

    def shutdown(self) -> None:
        """Stop recording for this client."""
        self._active = False
        self._unsubscribe()

    # --- observer ---------------------------------------------------------------------
    def on_render_error(self, app: str, env: str, name: str, error_type: str) -> None:
        if self._active:
            self._render_errors.add(1, {**self._base, "kyp.prompt.name": name, "error.type": error_type})

    def on_refresh(self, rec: RefreshRecord) -> None:
        if not self._active:
            return
        try:
            self._record(rec)
        except Exception:
            log.debug("telemetry failed", exc_info=True)

    def _record(self, rec: RefreshRecord) -> None:
        b = self._base
        attrs: Dict[str, Any] = {**b, "kyp.refresh.trigger": rec.trigger, "kyp.refresh.result": rec.result}
        if rec.source:
            attrs["kyp.source"] = rec.source
        self._duration.record(rec.duration, attrs)
        for ev in rec.events:
            a = ev.attributes
            if ev.name == "kyp.fallback":
                self._fallbacks.add(
                    1,
                    {
                        **b,
                        "kyp.source": a["kyp.source"],
                        "kyp.mirror": a["kyp.mirror"],
                        "error.type": a["error.type"],
                    },
                )
            elif ev.name == "kyp.hash_mismatch":
                self._mismatches.add(1, {**b, "kyp.source": a["kyp.source"], "kyp.mirror": a["kyp.mirror"]})
        if rec.result == "not_modified" and not rec.events and not self._trace_all:
            return
        span_attrs: Dict[str, Any] = {**b, "kyp.refresh.trigger": rec.trigger, "kyp.refresh.result": rec.result}
        if rec.revision:
            span_attrs["kyp.revision"] = rec.revision
        if rec.workspace:
            span_attrs["kyp.workspace"] = rec.workspace
        if rec.source:
            span_attrs["kyp.source"] = rec.source
            span_attrs["kyp.mirror"] = rec.mirror
        if rec.result == "failed":
            span_attrs["error.type"] = rec.error_type or "_OTHER"
        # Background and start-up rounds are root spans; a manual refresh joins the caller's trace.
        ctx = None if rec.trigger == "manual" else otel_context.Context()
        span = self._tracer.start_span(
            "kyp.refresh", context=ctx, kind=SpanKind.INTERNAL, attributes=span_attrs, start_time=rec.start_time_ns
        )
        for ev in rec.events:
            span.add_event(ev.name, dict(ev.attributes), timestamp=ev.time_ns)
        if rec.result == "failed":
            span.set_status(Status(StatusCode.ERROR, rec.error[:500]))
        span.end(end_time=rec.start_time_ns + int(rec.duration * 1e9))

    def _observe_staleness(self, _options: CallbackOptions) -> Iterable[Observation]:
        if not self._active:
            return []
        return [Observation(self._client.status().stale_for, self._base)]

    def _observe_revision(self, _options: CallbackOptions) -> Iterable[Observation]:
        if not self._active:
            return []
        return [Observation(self._client.revision, self._base)]


def instrument(client: Any, **options: Any) -> Instrumentation:
    """Record ``kyp.refresh`` spans and ``kyp.*`` metrics for a :class:`Client` or :class:`AsyncClient`.

    Options: ``tracer_provider``, ``meter_provider`` (default: the global ones), ``capture_content``
    (default False or ``KYP_OTEL_CAPTURE_CONTENT``; privacy: see the README), ``gen_ai_attributes``
    (default True), ``open_inference`` (default False), ``trace_all_refreshes`` (default False).
    """
    return Instrumentation(client, **options)


__all__ = ["REFRESH_BUCKETS", "SCOPE", "Instrumentation", "annotate", "instrument"]
