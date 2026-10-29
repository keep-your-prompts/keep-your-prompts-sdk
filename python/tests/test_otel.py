"""protocol/tracing.md conformance checklist, with in-memory OpenTelemetry exporters."""

from __future__ import annotations

from typing import Dict, List

import pytest

pytest.importorskip("opentelemetry.sdk")

from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import HistogramDataPoint, InMemoryMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from keepyourprompts import AsyncClient, Client, MissingVariableError, NotFoundError, Observer
from keepyourprompts.otel import annotate, instrument

from .conftest import FIXTURES, deploy, net_options
from .test_client import FakeApi

V12 = FIXTURES / "v12"
GREETING_SHA = "5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d"
TRIAGE_SHA = "f31befda9f5a0fed97bb07f8164baf8673f4342fcca9ad37d59dafaacefc53bf"


class Tel:
    def __init__(self) -> None:
        self.exporter = InMemorySpanExporter()
        self.tracer_provider = TracerProvider()
        self.tracer_provider.add_span_processor(SimpleSpanProcessor(self.exporter))
        self.reader = InMemoryMetricReader()
        self.meter_provider = MeterProvider(metric_readers=[self.reader])
        self.tracer = self.tracer_provider.get_tracer("app")

    def instrument(self, client, **kw):
        return instrument(client, tracer_provider=self.tracer_provider, meter_provider=self.meter_provider, **kw)

    def spans(self, name: str = "kyp.refresh"):
        return [s for s in self.exporter.get_finished_spans() if s.name == name]

    def metrics(self) -> Dict[str, list]:
        out: Dict[str, list] = {}
        data = self.reader.get_metrics_data()
        for rm in data.resource_metrics if data else []:
            for sm in rm.scope_metrics:
                assert sm.scope.name == "keepyourprompts"
                for m in sm.metrics:
                    out[m.name] = list(m.data.data_points)
        return out


@pytest.fixture
def tel():
    t = Tel()
    yield t
    t.meter_provider.shutdown()


def all_attrs(meta_source="snapshot") -> Dict[str, object]:
    return {
        "kyp.prompt.name": "greeting",
        "kyp.prompt.version": 4,
        "kyp.prompt.sha256": GREETING_SHA,
        "kyp.app": "demo",
        "kyp.env": "prod",
        "kyp.revision": 12,
        "kyp.workspace": "acme",
        "kyp.source": meta_source,
        "gen_ai.prompt.name": "greeting",
        "gen_ai.prompt.version": "4",
    }


# --- metadata (no OpenTelemetry needed) ---------------------------------------------
def test_meta_and_render_with_meta():
    with Client(app="demo", snapshot_dir=str(V12)) as c:
        assert c.meta("greeting").attributes() == all_attrs()
        r = c.render_with_meta("greeting", name="Ada", company="Acme")
        assert r.text == "Hello Ada, welcome to Acme." == str(r)
        assert (r.meta.sha256, r.meta.version, r.meta.revision) == (GREETING_SHA, 4, 12)
        with pytest.raises(NotFoundError):
            c.meta("nope")


def test_metadata_maps_are_flat():
    with Client(app="demo", snapshot_dir=str(V12)) as c:
        m = c.meta("triage")
        want = {
            "kyp_prompt_name": "triage",
            "kyp_prompt_version": 7,
            "kyp_prompt_sha256": TRIAGE_SHA,
            "kyp_app": "demo",
            "kyp_env": "prod",
            "kyp_revision": 12,
            "kyp_workspace": "acme",
            "kyp_source": "snapshot",
        }
        assert m.trace_metadata() == want
        assert m.langfuse_metadata() == want
        assert m.langsmith_metadata() == want


def test_report_with_meta_pins_the_body(cdn, tmp_path):
    srv = deploy("v12", tmp_path / "srv")
    s = cdn(cdn=srv)
    api = FakeApi()
    try:
        c = Client(**net_options(s, api_key="kyp_live_x", api_url=api.url))
        used = c.render_with_meta("greeting", name="A", company="B")
        deploy("v13", srv)
        assert c.refresh()
        assert c.prompt("greeting").version == 5
        c.report(used, "success", latency_ms=5)
        c.report(used.meta, "failure")
        c.close()
        body = api.calls[0][2]
        assert [(e["prompt"], e["sha256"]) for e in body] == [("greeting", GREETING_SHA)] * 2
    finally:
        api.stop()


# --- annotate -------------------------------------------------------------------------
def test_annotate_current_span_no_content(tel):
    with Client(app="demo", snapshot_dir=str(V12)) as c:
        otel = tel.instrument(c)
        with tel.tracer.start_as_current_span("llm.call"):
            meta = otel.annotate("greeting", variables={"name": "Ada"})
        assert meta.version == 4
        (span,) = tel.spans("llm.call")
        assert dict(span.attributes) == all_attrs()


def test_annotate_capture_content_and_openinference(tel):
    with Client(app="demo", snapshot_dir=str(V12)) as c:
        otel = tel.instrument(c, capture_content=True, open_inference=True)
        with tel.tracer.start_as_current_span("llm.call"):
            r = c.render_with_meta("greeting", name="Ada", company="Acme")
            otel.annotate(r, variables={"name": "Ada", "company": "Acme"})
        a = tel.spans("llm.call")[0].attributes
        assert a["kyp.prompt.template"] == "Hello {{name}}, welcome to {{ company }}."
        assert a["gen_ai.prompt.variable.name"] == "Ada"
        assert a["gen_ai.prompt.variable.company"] == "Acme"
        assert a["prompt.vendor"] == "keepyourprompts"
        assert a["prompt.id"] == "demo/prod/greeting"
        assert a["llm.prompt_template.version"] == "4"


def test_capture_content_from_env(tel, monkeypatch):
    monkeypatch.setenv("KYP_OTEL_CAPTURE_CONTENT", "true")
    with Client(app="demo", snapshot_dir=str(V12)) as c:
        otel = tel.instrument(c)
        with tel.tracer.start_as_current_span("llm.call"):
            otel.annotate("triage", variables={"company": "x"})
        assert tel.spans("llm.call")[0].attributes["gen_ai.prompt.variable.company"] == "x"


def test_free_annotate_explicit_span(tel):
    with Client(app="demo", snapshot_dir=str(V12)) as c:
        span = tel.tracer.start_span("explicit")
        annotate(c.meta("triage"), span=span, gen_ai_attributes=False, variables={"company": "x"})
        span.end()
        a = tel.spans("explicit")[0].attributes
        assert a["kyp.prompt.version"] == 7
        assert "gen_ai.prompt.name" not in a
        assert "gen_ai.prompt.variable.company" not in a
        assert annotate(c.meta("triage")).name == "triage"  # no current span: a no-op


# --- SDK spans and metrics -------------------------------------------------------------
def test_fallback_event_and_metrics(tel, cdn):
    s = cdn(cdn=V12, origin=V12)
    s.down("cdn")
    with Client(**net_options(s)) as c:
        otel = tel.instrument(c)
        assert c.refresh()
        (span,) = tel.spans()
        a = span.attributes
        assert a["kyp.refresh.trigger"] == "manual"
        assert a["kyp.refresh.result"] == "not_modified"
        assert (a["kyp.source"], a["kyp.mirror"], a["kyp.revision"], a["kyp.workspace"]) == (
            "origin",
            "origin",
            12,
            "acme",
        )
        fb = [e for e in span.events if e.name == "kyp.fallback"]
        assert len(fb) == 1
        assert fb[0].attributes["kyp.mirror"] == "cdn"
        assert fb[0].attributes["error.type"] == "http_503"
        m = tel.metrics()
        assert m["kyp.fallbacks"][0].value == 1
        assert m["kyp.fallbacks"][0].attributes["kyp.source"] == "cdn"
        assert isinstance(m["kyp.refresh.duration"][0], HistogramDataPoint)
        assert m["kyp.revision"][0].value == 12
        assert 0 <= m["kyp.staleness"][0].value < 5
        otel.shutdown()


def test_start_and_update_rounds(tel, cdn, tmp_path):
    srv = deploy("v12", tmp_path / "srv")
    s = cdn(cdn=srv)
    starts: List = []

    class Rec(Observer):
        def on_refresh(self, record):
            if record.trigger == "start":
                starts.append(record)

    with Client(**net_options(s, observer=Rec())) as c:
        tel.instrument(c)
        assert [(r.result, r.revision, r.source) for r in starts] == [("updated", 12, "cdn")]
        assert [e.name for e in starts[0].events] == ["kyp.update"]
        assert c.refresh()  # 304: not traced
        assert tel.spans() == []
        deploy("v13", srv)
        assert c.refresh()
        (span,) = tel.spans()
        assert span.attributes["kyp.refresh.result"] == "updated"
        assert span.attributes["kyp.revision"] == 13
        (upd,) = [e for e in span.events if e.name == "kyp.update"]
        assert dict(upd.attributes) == {"kyp.revision.previous": 12, "kyp.revision": 13, "kyp.prompts.changed": 1}
        counts = {p.attributes["kyp.refresh.result"]: p.count for p in tel.metrics()["kyp.refresh.duration"]}
        assert counts == {"not_modified": 1, "updated": 1}


def test_trace_all_and_failed_round(tel, cdn):
    s = cdn(cdn=V12, origin=V12)
    with Client(**net_options(s)) as c:
        tel.instrument(c, trace_all_refreshes=True)
        assert c.refresh()
        s.down("cdn")
        s.down("origin")
        assert not c.refresh()
        ok, failed = tel.spans()
        assert ok.attributes["kyp.refresh.result"] == "not_modified"
        assert failed.attributes["kyp.refresh.result"] == "failed"
        assert failed.attributes["error.type"] == "http_503"
        assert failed.status.status_code == StatusCode.ERROR
        assert "kyp.source" not in failed.attributes


def test_hash_mismatch(tel, cdn):
    s = cdn(cdn=FIXTURES / "tampered-v14", origin=FIXTURES / "v13")
    with Client(**net_options(s, snapshot_dir=str(V12))) as c:
        tel.instrument(c)
        assert c.refresh()
        assert c.revision == 13
        (span,) = tel.spans()
        assert [e.name for e in span.events] == ["kyp.hash_mismatch", "kyp.fallback", "kyp.update"]
        mm = span.events[0].attributes
        assert dict(mm) == {
            "kyp.mirror": "cdn",
            "kyp.source": "cdn",
            "kyp.blob.sha256": "fcadfa6b70f5b153be065e4f32dc011328b1aff4749fb3b748bba68a60c0838e",
        }
        assert span.events[1].attributes["error.type"] == "blob_unavailable"
        assert tel.metrics()["kyp.hash_mismatches"][0].value == 1


def test_render_errors_counted(tel):
    with Client(app="demo", snapshot_dir=str(V12)) as c:
        tel.instrument(c)
        with pytest.raises(MissingVariableError):
            c.render("greeting", name="x")
        with pytest.raises(MissingVariableError):
            c.render_with_meta("greeting")
        with pytest.raises(NotFoundError):
            c.render("nope")
        pts = tel.metrics()["kyp.render.errors"]
        by = {"%s/%s" % (p.attributes["kyp.prompt.name"], p.attributes["error.type"]): p.value for p in pts}
        assert by == {"greeting/missing_variable": 2, "nope/not_found": 1}


def test_throwing_observer_is_harmless():
    class Bad(Observer):
        def on_refresh(self, record):
            raise RuntimeError("boom")

        def on_render_error(self, *a):
            raise RuntimeError("boom")

    with Client(app="demo", snapshot_dir=str(V12), observer=Bad()) as c:
        with pytest.raises(MissingVariableError):
            c.render("greeting")
        assert "support agent" in c.get("triage")


async def test_async_client(tel, cdn, tmp_path):
    srv = deploy("v12", tmp_path / "srv")
    s = cdn(cdn=srv)
    async with AsyncClient(**net_options(s)) as c:
        otel = tel.instrument(c)
        deploy("v13", srv)
        with tel.tracer.start_as_current_span("parent") as parent:
            assert await c.refresh()
            r = c.render_with_meta("greeting", name="A", company="B")
            otel.annotate(r)
        (span,) = tel.spans()
        assert span.attributes["kyp.refresh.trigger"] == "manual"
        assert span.parent is not None and span.parent.span_id == parent.get_span_context().span_id
        assert tel.spans("parent")[0].attributes["kyp.prompt.version"] == 5
