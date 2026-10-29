// Keep Your Prompts: tracing adapter (protocol/tracing.md). Header-only, no dependency.
//
// Bridges the client's delivery telemetry and prompt metadata to any tracer and
// metrics backend: implement tracing::Tracer / tracing::Span / tracing::Meter
// over yours (or use <kyp/otel.hpp> for OpenTelemetry), then
//
//   auto inst = std::make_shared<kyp::tracing::Instrumentation>(my_tracer, my_meter);
//   kyp::Client prompts(kyp::Options::from_env().observer(inst));   // kyp.refresh spans + kyp.* metrics
//
//   auto r = prompts.render_with_meta("triage", {{"company", "Acme"}});
//   kyp::tracing::annotate(r.meta, [&](const std::string& k, const kyp::AttrValue& v) {
//     my_llm_span.set(k, v);                                            // kyp.* + gen_ai.prompt.*
//   });
#pragma once

#include <kyp/kyp.hpp>

#include <cctype>
#include <chrono>
#include <cstdlib>
#include <functional>
#include <memory>
#include <string>
#include <utility>

namespace kyp {
namespace tracing {

// Instrumentation scope (tracer and meter name), the same in every SDK.
inline constexpr const char* kScope = "keepyourprompts";
// Advice for kyp.refresh.duration (seconds).
inline constexpr double kRefreshBuckets[] = {0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10};

// A span created by Tracer::start_span.
class Span {
 public:
  virtual ~Span() = default;
  virtual void add_event(const std::string& name, std::chrono::system_clock::time_point time,
                         const Attributes& attributes) = 0;
  // Status ERROR with a short description (no delivery key).
  virtual void set_error(const std::string& description) = 0;
  // `duration` after the start time passed to start_span.
  virtual void end(std::chrono::nanoseconds duration) = 0;
};

class Tracer {
 public:
  virtual ~Tracer() = default;
  // Start a span of kind INTERNAL at `start`. child_of_current: parent it to the
  // caller's active span (a manual refresh); otherwise a root span.
  virtual std::unique_ptr<Span> start_span(const std::string& name, std::chrono::system_clock::time_point start,
                                           const Attributes& attributes, bool child_of_current) = 0;
};

// Synchronous instruments by name: kyp.refresh.duration (histogram, s),
// kyp.fallbacks, kyp.hash_mismatches, kyp.render.errors (counters).
// The gauges kyp.staleness and kyp.revision are observable: read gauge_values()
// from your backend's collection callback.
class Meter {
 public:
  virtual ~Meter() = default;
  virtual void record(const std::string& histogram, double value, const Attributes& attributes) = 0;
  virtual void add(const std::string& counter, std::int64_t value, const Attributes& attributes) = 0;
};

// KYP_OTEL_CAPTURE_CONTENT=true|1|yes|on
inline bool env_capture_content() {
  const char* v = std::getenv("KYP_OTEL_CAPTURE_CONTENT");
  if (!v) return false;
  std::string s(v);
  for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s == "1" || s == "true" || s == "yes" || s == "on";
}

struct AnnotateOptions {
  // Record the template and variable values (default: KYP_OTEL_CAPTURE_CONTENT).
  // PRIVACY: variable values often hold personal data; see the README.
  bool capture_content = env_capture_content();
  bool gen_ai_attributes = true;  // gen_ai.prompt.name / gen_ai.prompt.version
  bool open_inference = false;    // prompt.vendor, prompt.id, llm.prompt_template.*
  const Vars* variables = nullptr;           // recorded only with capture_content
  const std::string* template_text = nullptr;  // kyp.prompt.template, only with capture_content
};

namespace detail {
inline std::string json_string(const std::string& s) {
  std::string out = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          static const char* hex = "0123456789abcdef";
          out += "\\u00";
          out += hex[c >> 4];
          out += hex[c & 15];
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out + "\"";
}
}  // namespace detail

// Every attribute annotate() sets for `meta` (a pure function).
inline Attributes annotation(const PromptMeta& meta, const AnnotateOptions& o = {}) {
  Attributes a = meta.attributes(o.gen_ai_attributes);
  if (o.open_inference) {
    a.emplace_back("prompt.vendor", std::string("keepyourprompts"));
    a.emplace_back("prompt.id", meta.app + "/" + meta.env + "/" + meta.name);
    a.emplace_back("llm.prompt_template.version", std::to_string(meta.version));
  }
  if (o.capture_content) {
    if (o.template_text) {
      a.emplace_back("kyp.prompt.template", *o.template_text);
      if (o.open_inference) a.emplace_back("llm.prompt_template.template", *o.template_text);
    }
    if (o.variables && !o.variables->empty()) {
      std::string json = "{";
      for (const auto& kv : *o.variables) {
        a.emplace_back("gen_ai.prompt.variable." + kv.first, kv.second);
        if (json.size() > 1) json += ",";
        json += detail::json_string(kv.first) + ":" + detail::json_string(kv.second);
      }
      if (o.open_inference) a.emplace_back("llm.prompt_template.variables", json + "}");
    }
  }
  return a;
}

using AttributeSetter = std::function<void(const std::string& key, const AttrValue& value)>;

// Annotate the app's LLM span through `set` (one call per attribute). Never throws.
inline const PromptMeta& annotate(const PromptMeta& meta, const AttributeSetter& set, const AnnotateOptions& o = {}) {
  try {
    for (const auto& kv : annotation(meta, o)) set(kv.first, kv.second);
  } catch (...) {
    // telemetry never breaks the app
  }
  return meta;
}

// Annotate with the prompt `name` held by `client` (its template too when
// capturing content). Throws kyp::NotFound for an unknown name, nothing else.
inline PromptMeta annotate(const Client& client, std::string_view name, const AttributeSetter& set,
                           AnnotateOptions o = {}) {
  PromptMeta m = client.meta(name);
  std::string tmpl;
  if (o.capture_content && !o.template_text) {
    try {
      Prompt p = client.prompt(name);
      if (p.sha256 == m.sha256) {  // only the template of the very body the metadata names
        tmpl = std::move(p.text);
        o.template_text = &tmpl;
      }
    } catch (...) {
    }
  }
  annotate(m, set, o);
  return m;
}

// Values of the observable gauges kyp.staleness (s) and kyp.revision, with their attributes.
struct GaugeValues {
  double staleness_seconds = 0;
  std::int64_t revision = 0;
  Attributes attributes;  // kyp.app, kyp.env
};
inline GaugeValues gauge_values(const Client& client) {
  Status s = client.status();
  GaugeValues g;
  g.staleness_seconds = std::chrono::duration<double>(s.stale_for).count();
  g.revision = s.revision;
  g.attributes = {{"kyp.app", client.app()}, {"kyp.env", client.env()}};
  return g;
}

struct InstrumentationOptions {
  // Also export kyp.refresh spans for rounds that only confirmed what is held.
  bool trace_all_refreshes = false;
};

// An Observer that turns refresh rounds into kyp.refresh spans with events and
// into kyp.* metrics, and render errors into kyp.render.errors. Either sink may be null.
class Instrumentation : public Observer {
 public:
  Instrumentation(std::shared_ptr<Tracer> tracer, std::shared_ptr<Meter> meter, InstrumentationOptions o = {})
      : tracer_(std::move(tracer)), meter_(std::move(meter)), o_(o) {}

  void on_refresh(const RefreshRecord& r) override {
    try {
      record_metrics(r);
      if (r.result == RefreshResult::not_modified && r.events.empty() && !o_.trace_all_refreshes) return;
      record_span(r);
    } catch (...) {
    }
  }

  void on_render_error(const RenderError& e) override {
    try {
      if (meter_)
        meter_->add("kyp.render.errors", 1,
                    {{"kyp.app", e.app}, {"kyp.env", e.env}, {"kyp.prompt.name", e.name}, {"error.type", e.error_type}});
    } catch (...) {
    }
  }

 private:
  static AttrValue attr_or(const TelemetryEvent& e, const char* key, const char* fallback) {
    const AttrValue* v = e.attr(key);
    return v ? *v : AttrValue(std::string(fallback));
  }

  void record_metrics(const RefreshRecord& r) {
    if (!meter_) return;
    Attributes base{{"kyp.app", r.app}, {"kyp.env", r.env}};
    Attributes a = base;
    a.emplace_back("kyp.refresh.trigger", std::string(to_string(r.trigger)));
    a.emplace_back("kyp.refresh.result", std::string(to_string(r.result)));
    if (!r.source.empty()) a.emplace_back("kyp.source", r.source);
    meter_->record("kyp.refresh.duration", std::chrono::duration<double>(r.duration).count(), a);
    for (const auto& e : r.events) {
      if (e.name == "kyp.fallback") {
        Attributes f = base;
        f.emplace_back("kyp.source", attr_or(e, "kyp.source", ""));
        f.emplace_back("kyp.mirror", attr_or(e, "kyp.mirror", ""));
        f.emplace_back("error.type", attr_or(e, "error.type", "_OTHER"));
        meter_->add("kyp.fallbacks", 1, f);
      } else if (e.name == "kyp.hash_mismatch") {
        Attributes h = base;
        h.emplace_back("kyp.source", attr_or(e, "kyp.source", ""));
        h.emplace_back("kyp.mirror", attr_or(e, "kyp.mirror", ""));
        meter_->add("kyp.hash_mismatches", 1, h);
      }
    }
  }

  void record_span(const RefreshRecord& r) {
    if (!tracer_) return;
    Attributes a{{"kyp.app", r.app},
                 {"kyp.env", r.env},
                 {"kyp.refresh.trigger", std::string(to_string(r.trigger))},
                 {"kyp.refresh.result", std::string(to_string(r.result))}};
    if (r.revision > 0) a.emplace_back("kyp.revision", r.revision);
    if (!r.workspace.empty()) a.emplace_back("kyp.workspace", r.workspace);
    if (!r.source.empty()) {
      a.emplace_back("kyp.source", r.source);
      a.emplace_back("kyp.mirror", r.mirror);
    }
    bool failed = r.result == RefreshResult::failed;
    if (failed) a.emplace_back("error.type", r.error_type.empty() ? std::string("_OTHER") : r.error_type);
    // A manual refresh is a child of the caller's active span; start-up and polls are roots.
    auto span = tracer_->start_span("kyp.refresh", r.start_time, a, r.trigger == RefreshTrigger::manual);
    if (!span) return;
    for (const auto& e : r.events) span->add_event(e.name, e.time, e.attributes);
    if (failed) span->set_error(r.error.substr(0, 500));
    span->end(r.duration);
  }

  std::shared_ptr<Tracer> tracer_;
  std::shared_ptr<Meter> meter_;
  InstrumentationOptions o_;
};

}  // namespace tracing
}  // namespace kyp
