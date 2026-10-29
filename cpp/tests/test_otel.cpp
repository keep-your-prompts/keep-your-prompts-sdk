// <kyp/otel.hpp> against the opentelemetry-cpp SDK's in-memory exporters
// (protocol/tracing.md, conformance checklist). Built with -DKYP_WITH_OTEL=ON.
#include <kyp/kyp.hpp>
#include <kyp/otel.hpp>

#include <opentelemetry/exporters/memory/in_memory_metric_data.h>
#include <opentelemetry/exporters/memory/in_memory_metric_exporter_factory.h>
#include <opentelemetry/exporters/memory/in_memory_span_data.h>
#include <opentelemetry/exporters/memory/in_memory_span_exporter_factory.h>
#include <opentelemetry/sdk/metrics/export/periodic_exporting_metric_reader_factory.h>
#include <opentelemetry/sdk/metrics/meter_provider.h>
#include <opentelemetry/sdk/metrics/meter_provider_factory.h>
#include <opentelemetry/sdk/trace/simple_processor_factory.h>
#include <opentelemetry/sdk/trace/span_data.h>
#include <opentelemetry/sdk/trace/tracer_provider.h>
#include <opentelemetry/sdk/trace/tracer_provider_factory.h>
#include <opentelemetry/trace/scope.h>

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "check.hpp"
#include "util.hpp"

namespace otel_api = opentelemetry;
namespace sdk_trace = opentelemetry::sdk::trace;
namespace sdk_metrics = opentelemetry::sdk::metrics;
namespace memory = opentelemetry::exporter::memory;
using kyp::Mirror;

namespace {

std::string str(const opentelemetry::sdk::common::OwnedAttributeValue& v) {
  if (const auto* s = otel_api::nostd::get_if<std::string>(&v)) return *s;
  if (const auto* i = otel_api::nostd::get_if<std::int64_t>(&v)) return "i:" + std::to_string(*i);
  return "?";
}

std::map<std::string, std::string> attrs(const std::unordered_map<std::string, opentelemetry::sdk::common::OwnedAttributeValue>& a) {
  std::map<std::string, std::string> out;
  for (const auto& kv : a) out[kv.first] = str(kv.second);
  return out;
}

struct Harness {
  std::shared_ptr<memory::InMemorySpanData> span_data;
  std::shared_ptr<sdk_trace::TracerProvider> tracer_provider;
  std::shared_ptr<memory::SimpleAggregateInMemoryMetricData> metric_data =
      std::make_shared<memory::SimpleAggregateInMemoryMetricData>();
  std::shared_ptr<sdk_metrics::MeterProvider> meter_provider;
  std::vector<std::unique_ptr<sdk_trace::SpanData>> spans;

  Harness() {
    auto exporter = memory::InMemorySpanExporterFactory::Create(span_data);
    tracer_provider = sdk_trace::TracerProviderFactory::Create(sdk_trace::SimpleSpanProcessorFactory::Create(std::move(exporter)));
    meter_provider = std::shared_ptr<sdk_metrics::MeterProvider>(sdk_metrics::MeterProviderFactory::Create());
    sdk_metrics::PeriodicExportingMetricReaderOptions ro;
    ro.export_interval_millis = std::chrono::milliseconds(3600000);
    ro.export_timeout_millis = std::chrono::milliseconds(1000);
    meter_provider->AddMetricReader(
        sdk_metrics::PeriodicExportingMetricReaderFactory::Create(
            memory::InMemoryMetricExporterFactory::Create(
                metric_data, [](sdk_metrics::InstrumentType) { return sdk_metrics::AggregationTemporality::kCumulative; }),
            ro));
  }

  kyp::otel::Options options() const {
    kyp::otel::Options o;
    o.tracer_provider = otel_api::nostd::shared_ptr<otel_api::trace::TracerProvider>(tracer_provider);
    o.meter_provider = otel_api::nostd::shared_ptr<otel_api::metrics::MeterProvider>(meter_provider);
    o.annotate.capture_content = false;
    return o;
  }

  // Finished spans named `name` (drains the exporter into `spans` first).
  std::vector<const sdk_trace::SpanData*> named(const std::string& name) {
    for (auto& s : span_data->GetSpans()) spans.push_back(std::move(s));
    std::vector<const sdk_trace::SpanData*> out;
    for (auto& s : spans)
      if (std::string(s->GetName()) == name) out.push_back(s.get());
    return out;
  }

  // attributes -> value (counter sum, histogram count or gauge value) of `metric`.
  std::map<std::map<std::string, std::string>, double> metric(const std::string& name) {
    // SimpleAggregateInMemoryMetricData keeps the first point per series: clear, then
    // export the current cumulative values.
    metric_data->Clear();
    meter_provider->ForceFlush();
    std::map<std::map<std::string, std::string>, double> out;
    for (const auto& [pa, point] : metric_data->Get("keepyourprompts", name)) {
      std::map<std::string, std::string> a;
      for (const auto& kv : pa) a[kv.first] = str(kv.second);
      double v = 0;
      if (const auto* s = otel_api::nostd::get_if<sdk_metrics::SumPointData>(&point))
        v = otel_api::nostd::holds_alternative<double>(s->value_) ? otel_api::nostd::get<double>(s->value_)
                                                                  : static_cast<double>(otel_api::nostd::get<std::int64_t>(s->value_));
      else if (const auto* h = otel_api::nostd::get_if<sdk_metrics::HistogramPointData>(&point))
        v = static_cast<double>(h->count_);
      else if (const auto* g = otel_api::nostd::get_if<sdk_metrics::LastValuePointData>(&point))
        v = otel_api::nostd::holds_alternative<double>(g->value_) ? otel_api::nostd::get<double>(g->value_)
                                                                  : static_cast<double>(otel_api::nostd::get<std::int64_t>(g->value_));
      out[a] = v;
    }
    return out;
  }

  double total(const std::string& name) {
    double t = 0;
    for (const auto& kv : metric(name)) t += kv.second;
    return t;
  }
};

const std::map<std::string, std::string> kV1 = {{"greeting", "Hello {{name}} from {{company}}"},
                                                 {"triage", "Triage for {{company}}."}};

struct Fixture {
  TempDir t;
  Harness h;
  std::shared_ptr<kyp::otel::Instrumentation> otel;
  std::unique_ptr<kyp::Client> client;

  explicit Fixture(bool capture = false, bool trace_all = false, bool broken_is_good = false) {
    if (broken_is_good)
      write_snapshot(t / "broken", snap(1, kV1));
    else
      write_file(t / "broken" / "envs" / "support-bot" / "prod.json", "not json");
    write_snapshot(t / "snap", snap(1, kV1));
    auto o = h.options();
    o.annotate.capture_content = capture;
    o.annotate.open_inference = capture;
    o.trace_all_refreshes = trace_all;
    otel = kyp::otel::Instrumentation::create(o);
    client = std::make_unique<kyp::Client>(quiet_options()
                                               .mirrors({Mirror::file(t / "broken", "broken"),
                                                         Mirror::file(t / "snap", "snapshot")})
                                               .poll_interval(std::chrono::hours(1))
                                               .observer(otel->observer()));
    otel->attach(*client);
    // Folder-only clients poll their folders right after start-up: let that round happen.
    CHECK(eventually([&] { return h.total("kyp.refresh.duration") >= 2; }));
  }
  ~Fixture() { otel->detach(); }

  void deploy(std::int64_t revision, std::map<std::string, std::string> prompts, bool corrupt_greeting = false) {
    auto s = snap(revision, std::move(prompts));
    if (corrupt_greeting) s.corrupting("greeting");
    write_snapshot(t / "snap", s);
  }

  // Runs fn inside an active "llm.call" span; returns that span's data.
  template <typename F>
  const sdk_trace::SpanData* in_llm_span(F&& fn) {
    auto tracer = h.tracer_provider->GetTracer("app");
    auto span = tracer->StartSpan("llm.call");
    {
      otel_api::trace::Scope scope(span);
      fn();
    }
    span->End();
    return h.named("llm.call").back();
  }
};

}  // namespace

TEST(annotate_sets_kyp_and_gen_ai_attributes_without_content) {
  Fixture f;
  kyp::Vars vars{{"name", "Ada"}};
  kyp::PromptMeta meta;
  auto* span = f.in_llm_span([&] { meta = f.otel->annotate("greeting", &vars); });
  CHECK_EQ(meta.name, "greeting");
  auto a = attrs(span->GetAttributes());
  std::map<std::string, std::string> want{
      {"kyp.prompt.name", "greeting"},       {"kyp.prompt.version", "i:1"}, {"kyp.prompt.sha256", meta.sha256},
      {"kyp.app", "support-bot"},            {"kyp.env", "prod"},          {"kyp.revision", "i:1"},
      {"kyp.workspace", "acme"},             {"kyp.source", "snapshot"},   {"gen_ai.prompt.name", "greeting"},
      {"gen_ai.prompt.version", "1"}};
  CHECK(a == want);
}

TEST(capture_content_and_open_inference) {
  Fixture f(true);
  kyp::Vars vars{{"name", "Ada"}, {"company", "Acme"}};
  kyp::Rendered r = f.client->render_with_meta("greeting", vars);
  auto* span = f.in_llm_span([&] { f.otel->annotate(r.meta, &vars); });
  auto a = attrs(span->GetAttributes());
  // annotate(meta) has no template; annotate(name) adds it.
  CHECK(a.count("kyp.prompt.template") == 0);
  CHECK_EQ(a["gen_ai.prompt.variable.name"], "Ada");
  CHECK_EQ(a["gen_ai.prompt.variable.company"], "Acme");
  CHECK_EQ(a["prompt.vendor"], "keepyourprompts");
  CHECK_EQ(a["prompt.id"], "support-bot/prod/greeting");
  CHECK_EQ(a["llm.prompt_template.version"], "1");
  span = f.in_llm_span([&] { f.otel->annotate("greeting", &vars); });
  CHECK_EQ(attrs(span->GetAttributes())["kyp.prompt.template"], "Hello {{name}} from {{company}}");
}

TEST(annotate_explicit_span_and_no_op_without_one) {
  Fixture f;
  auto span = f.h.tracer_provider->GetTracer("app")->StartSpan("explicit");
  kyp::tracing::AnnotateOptions o;
  o.capture_content = false;
  o.gen_ai_attributes = false;
  kyp::otel::annotate(f.client->meta("triage"), o, span);
  span->End();
  auto a = attrs(f.h.named("explicit").back()->GetAttributes());
  CHECK_EQ(a["kyp.prompt.version"], "i:1");
  CHECK(a.count("gen_ai.prompt.name") == 0);
  CHECK_EQ(f.otel->annotate("triage").version, 1);  // no active span: a no-op
  CHECK_THROWS_AS(f.otel->annotate("nope"), kyp::NotFound);
}

TEST(refresh_spans_and_events) {
  Fixture f;
  f.deploy(2, {{"greeting", "Hi {{name}} from {{company}}"}, {"triage", "Triage for {{company}}."}});
  auto* llm = f.in_llm_span([&] { f.client->refresh_now(); });
  f.deploy(3, {{"greeting", "Tampered {{name}}"}, {"triage", "Triage for {{company}}."}}, true);
  f.client->refresh_now();

  auto all = f.h.named("kyp.refresh");
  CHECK_EQ(all.size(), 4u);  // start-up, first poll (a fallback), update, tampered
  const auto* start = all[0];
  CHECK(start->GetSpanKind() == otel_api::trace::SpanKind::kInternal);
  CHECK_EQ(std::string(start->GetInstrumentationScope().GetName()), "keepyourprompts");
  std::map<std::string, std::string> want{
      {"kyp.app", "support-bot"},       {"kyp.env", "prod"},     {"kyp.refresh.trigger", "start"},
      {"kyp.refresh.result", "updated"}, {"kyp.revision", "i:1"}, {"kyp.workspace", "acme"},
      {"kyp.source", "snapshot"},       {"kyp.mirror", "snapshot"}};
  CHECK(attrs(start->GetAttributes()) == want);
  CHECK_EQ(start->GetEvents().size(), 2u);
  CHECK_EQ(std::string(start->GetEvents()[0].GetName()), "kyp.fallback");
  CHECK_EQ(attrs(start->GetEvents()[0].GetAttributes())["error.type"], "bad_manifest");
  CHECK_EQ(std::string(start->GetEvents()[1].GetName()), "kyp.update");
  CHECK(!start->GetParentSpanId().IsValid());

  const auto* update = all[2];
  auto ua = attrs(update->GetAttributes());
  CHECK_EQ(ua["kyp.refresh.trigger"], "manual");
  CHECK_EQ(ua["kyp.revision"], "i:2");
  CHECK(update->GetParentSpanId() == llm->GetSpanId());
  auto ev = attrs(update->GetEvents().back().GetAttributes());
  CHECK_EQ(ev["kyp.revision.previous"], "i:1");
  CHECK_EQ(ev["kyp.prompts.changed"], "i:1");

  const auto* bad = all[3];
  auto ba = attrs(bad->GetAttributes());
  CHECK_EQ(ba["kyp.refresh.result"], "failed");
  CHECK_EQ(ba["error.type"], "blob_unavailable");
  CHECK(ba.count("kyp.source") == 0);
  CHECK(bad->GetStatus() == otel_api::trace::StatusCode::kError);
  bool mismatch = false;
  for (const auto& e : bad->GetEvents()) mismatch |= std::string(e.GetName()) == "kyp.hash_mismatch";
  CHECK(mismatch);
  CHECK(start->GetDuration().count() >= 0);
}

TEST(refresh_metrics_and_gauges) {
  Fixture f;
  f.deploy(2, {{"greeting", "Hi {{name}} from {{company}}"}, {"triage", "Triage for {{company}}."}});
  f.client->refresh_now();
  f.deploy(3, {{"greeting", "Tampered {{name}}"}, {"triage", "Triage for {{company}}."}}, true);
  f.client->refresh_now();

  CHECK_EQ(f.h.total("kyp.refresh.duration"), 4.0);
  auto d = f.h.metric("kyp.refresh.duration");
  std::map<std::string, std::string> start{{"kyp.app", "support-bot"},
                                           {"kyp.env", "prod"},
                                           {"kyp.refresh.trigger", "start"},
                                           {"kyp.refresh.result", "updated"},
                                           {"kyp.source", "snapshot"}};
  CHECK_EQ(d[start], 1.0);
  CHECK_EQ(f.h.total("kyp.fallbacks"), 5.0);  // broken x4 + the tampered snapshot
  std::map<std::string, std::string> fb{{"kyp.app", "support-bot"},
                                        {"kyp.env", "prod"},
                                        {"kyp.source", "snapshot"},
                                        {"kyp.mirror", "broken"},
                                        {"error.type", "bad_manifest"}};
  CHECK_EQ(f.h.metric("kyp.fallbacks")[fb], 4.0);
  CHECK_EQ(f.h.total("kyp.hash_mismatches"), 1.0);
  auto rev = f.h.metric("kyp.revision");
  CHECK_EQ(rev.size(), 1u);
  CHECK_EQ(rev.begin()->second, 2.0);
  CHECK(rev.begin()->first == (std::map<std::string, std::string>{{"kyp.app", "support-bot"}, {"kyp.env", "prod"}}));
  CHECK(f.h.total("kyp.staleness") >= 0.0);

  CHECK_THROWS_AS(f.client->render("greeting", {{"name", "Ada"}}), kyp::MissingVariable);
  CHECK_THROWS_AS(f.client->render("nope", {}), kyp::NotFound);
  auto e = f.h.metric("kyp.render.errors");
  CHECK_EQ(e.size(), 2u);
  std::map<std::string, std::string> mv{{"kyp.app", "support-bot"},
                                        {"kyp.env", "prod"},
                                        {"kyp.prompt.name", "greeting"},
                                        {"error.type", "missing_variable"}};
  CHECK_EQ(e[mv], 1.0);
}

TEST(uneventful_rounds_are_not_traced_unless_asked) {
  {
    Fixture f(false, false, true);
    f.client->refresh_now();
    CHECK_EQ(f.h.named("kyp.refresh").size(), 1u);
    CHECK_EQ(f.h.total("kyp.refresh.duration"), 3.0);
  }
  Fixture f(false, true, true);
  f.client->refresh_now();
  auto all = f.h.named("kyp.refresh");
  CHECK_EQ(all.size(), 3u);
  CHECK_EQ(attrs(all[2]->GetAttributes())["kyp.refresh.result"], "not_modified");
}

CHECK_MAIN
