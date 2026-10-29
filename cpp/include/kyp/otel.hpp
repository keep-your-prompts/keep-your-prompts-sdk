// Keep Your Prompts: OpenTelemetry adapter (protocol/tracing.md). Header-only.
//
// Needs the opentelemetry-cpp API (header-only): configure kyp with
// -DKYP_WITH_OTEL=ON and link kyp::otel, which adds opentelemetry-cpp::api.
// Your app installs the SDK and exporters as usual.
//
//   #include <kyp/otel.hpp>
//   auto otel = kyp::otel::Instrumentation::create();       // global tracer/meter providers
//   kyp::Client prompts(kyp::Options::from_env().observer(otel->observer()));
//   otel->attach(prompts);                                   // kyp.staleness / kyp.revision gauges
//
//   auto r = prompts.render_with_meta("triage", {{"company", "Acme"}});
//   kyp::otel::annotate(r.meta);                            // kyp.* + gen_ai.prompt.* on the active span
//
// PRIVACY: with capture_content (or KYP_OTEL_CAPTURE_CONTENT=true) annotate()
// also records the template and variable values, which often hold personal
// data. Off by default.
#pragma once

#include <kyp/kyp.hpp>
#include <kyp/tracing.hpp>

#include <opentelemetry/common/attribute_value.h>
#include <opentelemetry/common/key_value_iterable_view.h>
#include <opentelemetry/common/timestamp.h>
#include <opentelemetry/context/context.h>
#include <opentelemetry/context/runtime_context.h>
#include <opentelemetry/metrics/async_instruments.h>
#include <opentelemetry/metrics/meter.h>
#include <opentelemetry/metrics/meter_provider.h>
#include <opentelemetry/metrics/observer_result.h>
#include <opentelemetry/metrics/provider.h>
#include <opentelemetry/metrics/sync_instruments.h>
#include <opentelemetry/nostd/shared_ptr.h>
#include <opentelemetry/nostd/string_view.h>
#include <opentelemetry/nostd/unique_ptr.h>
#include <opentelemetry/nostd/variant.h>
#include <opentelemetry/trace/context.h>
#include <opentelemetry/trace/provider.h>
#include <opentelemetry/trace/span.h>
#include <opentelemetry/trace/span_metadata.h>
#include <opentelemetry/trace/span_startoptions.h>
#include <opentelemetry/trace/tracer.h>
#include <opentelemetry/trace/tracer_provider.h>

#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace kyp {
namespace otel {

namespace otel_api = ::opentelemetry;
using KeyValues = std::vector<std::pair<otel_api::nostd::string_view, otel_api::common::AttributeValue>>;

// Views into `a` (which must outlive the result).
inline KeyValues key_values(const Attributes& a) {
  KeyValues kv;
  kv.reserve(a.size());
  for (const auto& p : a) {
    if (const auto* s = std::get_if<std::string>(&p.second))
      kv.emplace_back(otel_api::nostd::string_view(p.first), otel_api::nostd::string_view(*s));
    else
      kv.emplace_back(otel_api::nostd::string_view(p.first), std::get<std::int64_t>(p.second));
  }
  return kv;
}

// The span of the current context (a no-op span when none is active).
inline otel_api::nostd::shared_ptr<otel_api::trace::Span> current_span() {
  return otel_api::trace::GetSpan(otel_api::context::RuntimeContext::GetCurrent());
}

// Annotate `span` (default: the active one) with the prompt used. A span that is
// not recording is left alone; never throws.
inline const PromptMeta& annotate(const PromptMeta& meta, const tracing::AnnotateOptions& o = {},
                                  otel_api::nostd::shared_ptr<otel_api::trace::Span> span = {}) {
  try {
    if (!span) span = current_span();
    if (!span || !span->IsRecording()) return meta;
    for (const auto& kv : tracing::annotation(meta, o)) {
      if (const auto* s = std::get_if<std::string>(&kv.second))
        span->SetAttribute(kv.first, otel_api::nostd::string_view(*s));
      else
        span->SetAttribute(kv.first, std::get<std::int64_t>(kv.second));
    }
  } catch (...) {
  }
  return meta;
}

// tracing::Tracer over an OpenTelemetry tracer.
class Tracer : public tracing::Tracer {
 public:
  explicit Tracer(otel_api::nostd::shared_ptr<otel_api::trace::Tracer> t) : t_(std::move(t)) {}

  std::unique_ptr<tracing::Span> start_span(const std::string& name, std::chrono::system_clock::time_point start,
                                            const Attributes& attributes, bool child_of_current) override {
    otel_api::trace::StartSpanOptions opts;
    opts.kind = otel_api::trace::SpanKind::kInternal;
    // Place the span at its real start; steady time derived from the same instant.
    auto steady_start = std::chrono::steady_clock::now() -
                        std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                            std::chrono::system_clock::now() - start);
    opts.start_system_time = otel_api::common::SystemTimestamp(start);
    opts.start_steady_time = otel_api::common::SteadyTimestamp(steady_start);
    if (child_of_current)
      opts.parent = otel_api::context::RuntimeContext::GetCurrent();
    else
      opts.parent = otel_api::context::Context{otel_api::trace::kIsRootSpanKey, true};
    KeyValues kv = key_values(attributes);
    auto span = t_->StartSpan(name, otel_api::common::KeyValueIterableView<KeyValues>(kv), opts);
    return std::unique_ptr<tracing::Span>(new SpanImpl(std::move(span), steady_start));
  }

 private:
  class SpanImpl : public tracing::Span {
   public:
    SpanImpl(otel_api::nostd::shared_ptr<otel_api::trace::Span> s, std::chrono::steady_clock::time_point start)
        : s_(std::move(s)), start_(start) {}
    void add_event(const std::string& name, std::chrono::system_clock::time_point time,
                   const Attributes& attributes) override {
      KeyValues kv = key_values(attributes);
      s_->AddEvent(name, otel_api::common::SystemTimestamp(time), otel_api::common::KeyValueIterableView<KeyValues>(kv));
    }
    void set_error(const std::string& description) override {
      s_->SetStatus(otel_api::trace::StatusCode::kError, description);
    }
    void end(std::chrono::nanoseconds duration) override {
      otel_api::trace::EndSpanOptions eo;
      eo.end_steady_time = otel_api::common::SteadyTimestamp(
          start_ + std::chrono::duration_cast<std::chrono::steady_clock::duration>(duration));
      s_->End(eo);
    }

   private:
    otel_api::nostd::shared_ptr<otel_api::trace::Span> s_;
    std::chrono::steady_clock::time_point start_;
  };

  otel_api::nostd::shared_ptr<otel_api::trace::Tracer> t_;
};

// tracing::Meter over an OpenTelemetry meter: kyp.refresh.duration, kyp.fallbacks,
// kyp.hash_mismatches, kyp.render.errors. (The C++ API has no bucket advice: to use
// the recommended buckets tracing::kRefreshBuckets, add a View in your SDK setup.)
class Meter : public tracing::Meter {
 public:
  explicit Meter(otel_api::nostd::shared_ptr<otel_api::metrics::Meter> m) : m_(std::move(m)) {
    duration_ = m_->CreateDoubleHistogram("kyp.refresh.duration", "Wall time of each prompt refresh round.", "s");
    fallbacks_ = m_->CreateUInt64Counter("kyp.fallbacks", "Mirror failures that made a refresh move on.",
                                         "{fallback}");
    mismatches_ = m_->CreateUInt64Counter("kyp.hash_mismatches",
                                          "Prompt bodies discarded because their SHA-256 did not match.", "{blob}");
    render_errors_ = m_->CreateUInt64Counter("kyp.render.errors",
                                             "render failures: unknown prompt or missing variable.", "{error}");
  }

  void record(const std::string& histogram, double value, const Attributes& attributes) override {
    if (histogram != "kyp.refresh.duration" || !duration_) return;
    KeyValues kv = key_values(attributes);
    duration_->Record(value, otel_api::common::KeyValueIterableView<KeyValues>(kv), otel_api::context::Context{});
  }

  void add(const std::string& counter, std::int64_t value, const Attributes& attributes) override {
    otel_api::metrics::Counter<std::uint64_t>* c = counter == "kyp.fallbacks"         ? fallbacks_.get()
                                                   : counter == "kyp.hash_mismatches" ? mismatches_.get()
                                                   : counter == "kyp.render.errors"   ? render_errors_.get()
                                                                                      : nullptr;
    if (!c || value < 0) return;
    KeyValues kv = key_values(attributes);
    c->Add(static_cast<std::uint64_t>(value), otel_api::common::KeyValueIterableView<KeyValues>(kv));
  }

  const otel_api::nostd::shared_ptr<otel_api::metrics::Meter>& meter() const { return m_; }

 private:
  otel_api::nostd::shared_ptr<otel_api::metrics::Meter> m_;
  otel_api::nostd::unique_ptr<otel_api::metrics::Histogram<double>> duration_;
  otel_api::nostd::unique_ptr<otel_api::metrics::Counter<std::uint64_t>> fallbacks_, mismatches_, render_errors_;
};

struct Options {
  // Default: the global providers.
  otel_api::nostd::shared_ptr<otel_api::trace::TracerProvider> tracer_provider;
  otel_api::nostd::shared_ptr<otel_api::metrics::MeterProvider> meter_provider;
  // Annotation defaults for Instrumentation::annotate. capture_content defaults to
  // KYP_OTEL_CAPTURE_CONTENT. PRIVACY: see the README.
  tracing::AnnotateOptions annotate;
  bool trace_all_refreshes = false;
};

// kyp.refresh spans, kyp.* metrics, the observable gauges and annotate().
class Instrumentation {
 public:
  static std::shared_ptr<Instrumentation> create(Options o = {}) {
    return std::shared_ptr<Instrumentation>(new Instrumentation(std::move(o)));
  }

  ~Instrumentation() { detach(); }
  Instrumentation(const Instrumentation&) = delete;
  Instrumentation& operator=(const Instrumentation&) = delete;

  // Pass to Options::observer() (so the start-up round is traced) or Client::add_observer().
  std::shared_ptr<Observer> observer() const { return observer_; }

  // Register the kyp.staleness and kyp.revision gauges for `client`, and let
  // annotate(name) resolve names. The client must outlive the attachment (or call detach()).
  void attach(const Client& client) {
    detach();
    std::lock_guard<std::mutex> lk(mu_);
    client_ = &client;
    gauge_attrs_ = {{"kyp.app", client.app()}, {"kyp.env", client.env()}};
    auto& m = meter_->meter();
    staleness_ = m->CreateDoubleObservableGauge("kyp.staleness", "Seconds since a mirror last confirmed the prompts held.",
                                                "s");
    revision_ = m->CreateInt64ObservableGauge("kyp.revision", "Manifest revision held (0 when nothing is loaded).",
                                              "{revision}");
    if (staleness_) staleness_->AddCallback(&Instrumentation::observe_staleness, this);
    if (revision_) revision_->AddCallback(&Instrumentation::observe_revision, this);
  }

  void detach() {
    std::lock_guard<std::mutex> lk(mu_);
    if (staleness_) staleness_->RemoveCallback(&Instrumentation::observe_staleness, this);
    if (revision_) revision_->RemoveCallback(&Instrumentation::observe_revision, this);
    staleness_ = nullptr;
    revision_ = nullptr;
    client_ = nullptr;
  }

  // Annotate a span (default: the active one) with the prompt `name` of the attached
  // client. Throws kyp::NotFound for an unknown name (or kyp::Error without a client).
  PromptMeta annotate(std::string_view name, const Vars* variables = nullptr,
                      otel_api::nostd::shared_ptr<otel_api::trace::Span> span = {}) const {
    const Client* c;
    {
      std::lock_guard<std::mutex> lk(mu_);
      c = client_;
    }
    if (!c) throw Error("kyp: annotate(name) needs an attached client");
    PromptMeta m = c->meta(name);
    tracing::AnnotateOptions o = o_.annotate;
    o.variables = variables;
    std::string tmpl;
    if (o.capture_content) {
      try {
        Prompt p = c->prompt(name);
        if (p.sha256 == m.sha256) {
          tmpl = std::move(p.text);
          o.template_text = &tmpl;
        }
      } catch (...) {
      }
    }
    otel::annotate(m, o, std::move(span));
    return m;
  }

  // Annotate with metadata from meta() / render_with_meta().
  const PromptMeta& annotate(const PromptMeta& meta, const Vars* variables = nullptr,
                             otel_api::nostd::shared_ptr<otel_api::trace::Span> span = {}) const {
    tracing::AnnotateOptions o = o_.annotate;
    o.variables = variables;
    return otel::annotate(meta, o, std::move(span));
  }

 private:
  explicit Instrumentation(Options o) : o_(std::move(o)) {
    auto tp = o_.tracer_provider ? o_.tracer_provider : otel_api::trace::Provider::GetTracerProvider();
    auto mp = o_.meter_provider ? o_.meter_provider : otel_api::metrics::Provider::GetMeterProvider();
    tracer_ = std::make_shared<otel::Tracer>(tp->GetTracer(tracing::kScope, KYP_VERSION_STRING));
    meter_ = std::make_shared<otel::Meter>(mp->GetMeter(tracing::kScope, KYP_VERSION_STRING));
    tracing::InstrumentationOptions io;
    io.trace_all_refreshes = o_.trace_all_refreshes;
    observer_ = std::make_shared<tracing::Instrumentation>(tracer_, meter_, io);
  }

  template <typename T>
  static void observe(otel_api::metrics::ObserverResult& result, T value, const Attributes& attrs) {
    using Ptr = otel_api::nostd::shared_ptr<otel_api::metrics::ObserverResultT<T>>;
    if (otel_api::nostd::holds_alternative<Ptr>(result)) {
      KeyValues kv = key_values(attrs);
      otel_api::nostd::get<Ptr>(result)->Observe(value, otel_api::common::KeyValueIterableView<KeyValues>(kv));
    }
  }

  static void observe_staleness(otel_api::metrics::ObserverResult result, void* state) {
    auto* self = static_cast<Instrumentation*>(state);
    std::lock_guard<std::mutex> lk(self->mu_);
    if (!self->client_) return;
    observe<double>(result, tracing::gauge_values(*self->client_).staleness_seconds, self->gauge_attrs_);
  }

  static void observe_revision(otel_api::metrics::ObserverResult result, void* state) {
    auto* self = static_cast<Instrumentation*>(state);
    std::lock_guard<std::mutex> lk(self->mu_);
    if (!self->client_) return;
    observe<std::int64_t>(result, self->client_->revision(), self->gauge_attrs_);
  }

  Options o_;
  std::shared_ptr<otel::Tracer> tracer_;
  std::shared_ptr<otel::Meter> meter_;
  std::shared_ptr<tracing::Instrumentation> observer_;
  mutable std::mutex mu_;
  const Client* client_ = nullptr;
  Attributes gauge_attrs_;
  otel_api::nostd::shared_ptr<otel_api::metrics::ObservableInstrument> staleness_, revision_;
};

}  // namespace otel
}  // namespace kyp
