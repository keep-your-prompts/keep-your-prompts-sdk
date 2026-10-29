// Prompt metadata, the observer hook and the dependency-free tracing adapter
// (protocol/tracing.md), with fakes.
#include <kyp/kyp.hpp>
#include <kyp/tracing.hpp>

#include <algorithm>
#include <map>
#include <memory>
#include <mutex>
#include <vector>

#include "check.hpp"
#include "util.hpp"

using kyp::AttrValue;
using kyp::Mirror;

namespace {

struct Recorder : kyp::Observer {
  std::mutex mu;
  std::vector<kyp::RefreshRecord> refreshes;
  std::vector<kyp::RenderError> render_errors;
  void on_refresh(const kyp::RefreshRecord& r) override {
    std::lock_guard<std::mutex> lk(mu);
    refreshes.push_back(r);
  }
  void on_render_error(const kyp::RenderError& e) override {
    std::lock_guard<std::mutex> lk(mu);
    render_errors.push_back(e);
  }
  std::size_t count() {
    std::lock_guard<std::mutex> lk(mu);
    return refreshes.size();
  }
  kyp::RefreshRecord last() {
    std::lock_guard<std::mutex> lk(mu);
    return refreshes.back();
  }
  kyp::RefreshRecord at(std::size_t i) {
    std::lock_guard<std::mutex> lk(mu);
    return refreshes.at(i);
  }
};

const std::map<std::string, std::string> kV1 = {{"greeting", "Hello {{name}} from {{company}}"},
                                                 {"triage", "Triage for {{company}}."}};

// Two folder mirrors: "broken" (a manifest that is not JSON) first, then "snapshot".
// Folder-only clients poll their folders right after start-up: wait for that round.
struct Fixture {
  TempDir t;
  std::map<std::string, std::string> shas;
  std::unique_ptr<kyp::Client> client;

  explicit Fixture(std::shared_ptr<kyp::Observer> obs, Recorder* rec = nullptr, bool broken_is_good = false) {
    if (broken_is_good)
      write_snapshot(t / "broken", snap(1, kV1));
    else
      write_file(t / "broken" / "envs" / "support-bot" / "prod.json", "not json");
    shas = write_snapshot(t / "snap", snap(1, kV1));
    client = std::make_unique<kyp::Client>(quiet_options()
                                               .mirrors({Mirror::file(t / "broken", "broken"),
                                                         Mirror::file(t / "snap", "snapshot")})
                                               .poll_interval(std::chrono::hours(1))
                                               .observer(std::move(obs)));
    if (rec) CHECK(eventually([&] { return rec->count() >= 2; }));
  }
  void deploy(std::int64_t revision, std::map<std::string, std::string> prompts, bool corrupt_greeting = false) {
    auto s = snap(revision, std::move(prompts));
    if (corrupt_greeting) s.corrupting("greeting");
    write_snapshot(t / "snap", s);
  }
};

std::vector<std::string> names(const kyp::RefreshRecord& r) {
  std::vector<std::string> out;
  for (const auto& e : r.events) out.push_back(e.name);
  return out;
}

AttrValue S(const char* s) { return AttrValue(std::string(s)); }
AttrValue I(std::int64_t i) { return AttrValue(i); }

}  // namespace

TEST(meta_and_render_with_meta) {
  auto rec = std::make_shared<Recorder>();
  Fixture f(rec, rec.get());
  kyp::PromptMeta m = f.client->meta("greeting");
  CHECK_EQ(m.name, "greeting");
  CHECK_EQ(m.version, 1);
  CHECK_EQ(m.sha256, f.shas["greeting"]);
  CHECK_EQ(m.app, "support-bot");
  CHECK_EQ(m.env, "prod");
  CHECK_EQ(m.workspace, "acme");
  CHECK_EQ(m.revision, 1);
  CHECK_EQ(m.source, "snapshot");
  kyp::Rendered r = f.client->render_with_meta("greeting", {{"name", "Ada"}, {"company", "Acme"}});
  CHECK_EQ(r.text, "Hello Ada from Acme");
  CHECK(r.meta == m);
  CHECK_THROWS_AS(f.client->meta("nope"), kyp::NotFound);
}

TEST(attributes_and_metadata_maps) {
  auto rec = std::make_shared<Recorder>();
  Fixture f(rec, rec.get());
  kyp::PromptMeta m = f.client->meta("triage");
  kyp::Attributes a = m.attributes();
  std::vector<std::string> keys;
  for (const auto& kv : a) keys.push_back(kv.first);
  CHECK(keys == (std::vector<std::string>{"kyp.prompt.name", "kyp.prompt.version", "kyp.prompt.sha256", "kyp.app",
                                          "kyp.env", "kyp.revision", "kyp.workspace", "kyp.source",
                                          "gen_ai.prompt.name", "gen_ai.prompt.version"}));
  CHECK(a[1].second == I(1));
  CHECK(a[9].second == S("1"));  // gen_ai.prompt.version is a string
  CHECK_EQ(m.attributes(false).size(), 8u);
  std::vector<std::string> flat;
  for (const auto& kv : m.trace_metadata()) flat.push_back(kv.first);
  CHECK(flat == (std::vector<std::string>{"kyp_prompt_name", "kyp_prompt_version", "kyp_prompt_sha256", "kyp_app",
                                          "kyp_env", "kyp_revision", "kyp_workspace", "kyp_source"}));
  CHECK(m.langfuse_metadata() == m.trace_metadata());
  CHECK(m.langsmith_metadata() == m.trace_metadata());
  kyp::PromptMeta bare = m;
  bare.workspace.clear();
  bare.source.clear();
  CHECK_EQ(bare.attributes(false).size(), 6u);
}

TEST(start_round_with_fallback_and_update) {
  auto rec = std::make_shared<Recorder>();
  Fixture f(rec, rec.get());
  kyp::RefreshRecord r = rec->at(0);
  CHECK(r.trigger == kyp::RefreshTrigger::start);
  CHECK(r.result == kyp::RefreshResult::updated);
  CHECK_EQ(r.mirror, "snapshot");
  CHECK_EQ(r.source, "snapshot");
  CHECK_EQ(r.revision, 1);
  CHECK_EQ(r.previous_revision, 0);
  CHECK_EQ(r.workspace, "acme");
  CHECK(names(r) == (std::vector<std::string>{"kyp.fallback", "kyp.update"}));
  CHECK(*r.events[0].attr("kyp.mirror") == S("broken"));
  CHECK(*r.events[0].attr("kyp.source") == S("snapshot"));
  CHECK(*r.events[0].attr("error.type") == S("bad_manifest"));
  CHECK(*r.events[1].attr("kyp.revision.previous") == I(0));
  CHECK(*r.events[1].attr("kyp.revision") == I(1));
  CHECK(*r.events[1].attr("kyp.prompts.changed") == I(2));
  kyp::RefreshRecord p = rec->at(1);
  CHECK(p.trigger == kyp::RefreshTrigger::poll);
  CHECK(p.result == kyp::RefreshResult::not_modified);
}

TEST(update_not_modified_and_hash_mismatch) {
  auto rec = std::make_shared<Recorder>();
  Fixture f(rec, rec.get());
  f.deploy(2, {{"greeting", "Hi {{name}} from {{company}}"}, {"triage", "Triage for {{company}}."}});
  CHECK(f.client->refresh_now());
  kyp::RefreshRecord r = rec->last();
  CHECK(r.trigger == kyp::RefreshTrigger::manual);
  CHECK(r.result == kyp::RefreshResult::updated);
  CHECK_EQ(r.previous_revision, 1);
  CHECK_EQ(r.revision, 2);
  CHECK(*r.events.back().attr("kyp.prompts.changed") == I(1));

  CHECK(f.client->refresh_now());
  CHECK(rec->last().result == kyp::RefreshResult::not_modified);

  f.deploy(3, {{"greeting", "Tampered {{name}}"}, {"triage", "Triage for {{company}}."}}, true);
  CHECK(!f.client->refresh_now());
  r = rec->last();
  CHECK(r.result == kyp::RefreshResult::failed);
  CHECK_EQ(r.source, "");
  CHECK_EQ(r.error_type, "blob_unavailable");
  const kyp::TelemetryEvent* hm = nullptr;
  for (const auto& e : r.events)
    if (e.name == "kyp.hash_mismatch") hm = &e;
  CHECK(hm != nullptr);
  CHECK(*hm->attr("kyp.mirror") == S("snapshot"));
  CHECK(*hm->attr("kyp.blob.sha256") == AttrValue(kyp::sha256_hex("Tampered {{name}}")));
  CHECK_EQ(f.client->revision(), 2);
}

TEST(render_errors_and_observer_isolation) {
  auto rec = std::make_shared<Recorder>();
  Fixture f(rec, rec.get());
  CHECK_THROWS_AS(f.client->render("greeting", {{"name", "Ada"}}), kyp::MissingVariable);
  CHECK_THROWS_AS(f.client->render_with_meta("nope", {}), kyp::NotFound);
  CHECK_EQ(rec->render_errors.size(), 2u);
  CHECK_EQ(rec->render_errors[0].name, "greeting");
  CHECK_EQ(rec->render_errors[0].error_type, "missing_variable");
  CHECK_EQ(rec->render_errors[1].error_type, "not_found");

  struct Boom : kyp::Observer {
    void on_refresh(const kyp::RefreshRecord&) override { throw std::runtime_error("boom"); }
  };
  auto id = f.client->add_observer(std::make_shared<Boom>());
  CHECK(f.client->refresh_now());
  CHECK(f.client->remove_observer(id));
  auto extra = std::make_shared<Recorder>();
  id = f.client->add_observer(extra);
  f.client->refresh_now();
  CHECK(f.client->remove_observer(id));
  CHECK(!f.client->remove_observer(id));
  f.client->refresh_now();
  CHECK_EQ(extra->count(), 1u);
}

TEST(normalize_and_classify) {
  CHECK_EQ(kyp::normalize_source("disk-cache", "cache"), "cache");
  CHECK_EQ(kyp::normalize_source("cdn", "http"), "cdn");
  CHECK_EQ(kyp::normalize_source("eu", "http"), "custom");
  CHECK_EQ(kyp::normalize_source("local", "file"), "snapshot");
  CHECK_EQ(kyp::normalize_source("x", "embedded"), "embedded");
  CHECK_EQ(kyp::normalize_source("", "http"), "");
  CHECK_EQ(kyp::classify_error("HTTP 503"), "http_503");
  CHECK_EQ(kyp::classify_error("manifest not found (HTTP 404)"), "not_found");
  CHECK_EQ(kyp::classify_error("manifest not found (no such file: /x)"), "not_found");
  CHECK_EQ(kyp::classify_error("Timeout was reached"), "timeout");
  CHECK_EQ(kyp::classify_error("Couldn't connect to server"), "network");
  CHECK_EQ(kyp::classify_error("stale manifest ignored (revision 1 < held 2)"), "stale");
  CHECK_EQ(kyp::classify_error("bad manifest: parse error"), "bad_manifest");
  CHECK_EQ(kyp::classify_error("weird"), "_OTHER");
}

// --- the tracing adapter with a fake tracer and meter ------------------------

namespace {

struct FakeSpan {
  std::string name;
  kyp::Attributes attributes;
  bool child_of_current = false;
  std::vector<std::string> events;
  std::vector<kyp::Attributes> event_attributes;
  std::string error;
  bool ended = false;
};

struct FakeTracer : kyp::tracing::Tracer {
  std::mutex mu;
  std::vector<std::shared_ptr<FakeSpan>> spans;
  struct S : kyp::tracing::Span {
    std::shared_ptr<FakeSpan> d;
    void add_event(const std::string& n, std::chrono::system_clock::time_point, const kyp::Attributes& a) override {
      d->events.push_back(n);
      d->event_attributes.push_back(a);
    }
    void set_error(const std::string& e) override { d->error = e; }
    void end(std::chrono::nanoseconds) override { d->ended = true; }
  };
  std::unique_ptr<kyp::tracing::Span> start_span(const std::string& name, std::chrono::system_clock::time_point,
                                                 const kyp::Attributes& a, bool child) override {
    auto d = std::make_shared<FakeSpan>();
    d->name = name;
    d->attributes = a;
    d->child_of_current = child;
    std::lock_guard<std::mutex> lk(mu);
    spans.push_back(d);
    auto s = std::make_unique<S>();
    s->d = d;
    return s;
  }
  std::vector<std::shared_ptr<FakeSpan>> all() {
    std::lock_guard<std::mutex> lk(mu);
    return spans;
  }
};

struct FakeMeter : kyp::tracing::Meter {
  std::mutex mu;
  std::vector<std::pair<std::string, kyp::Attributes>> histograms, counters;
  void record(const std::string& h, double, const kyp::Attributes& a) override {
    std::lock_guard<std::mutex> lk(mu);
    histograms.emplace_back(h, a);
  }
  void add(const std::string& c, std::int64_t, const kyp::Attributes& a) override {
    std::lock_guard<std::mutex> lk(mu);
    counters.emplace_back(c, a);
  }
  std::size_t count(const std::string& name) {
    std::lock_guard<std::mutex> lk(mu);
    std::size_t n = 0;
    for (auto& c : counters) n += c.first == name;
    for (auto& h : histograms) n += h.first == name;
    return n;
  }
};

const AttrValue* find(const kyp::Attributes& a, const std::string& k) {
  for (const auto& kv : a)
    if (kv.first == k) return &kv.second;
  return nullptr;
}

}  // namespace

TEST(adapter_records_refresh_spans_events_and_metrics) {
  auto tracer = std::make_shared<FakeTracer>();
  auto meter = std::make_shared<FakeMeter>();
  auto inst = std::make_shared<kyp::tracing::Instrumentation>(tracer, meter);
  Fixture f(inst);
  CHECK(eventually([&] { return meter->count("kyp.refresh.duration") >= 2; }));
  f.deploy(2, {{"greeting", "Hi {{name}} from {{company}}"}, {"triage", "Triage for {{company}}."}});
  f.client->refresh_now();
  f.deploy(3, {{"greeting", "Tampered {{name}}"}, {"triage", "Triage for {{company}}."}}, true);
  f.client->refresh_now();

  auto spans = tracer->all();
  CHECK_EQ(spans.size(), 4u);  // start, first poll (it had a fallback), update, tampered
  auto& start = *spans[0];
  CHECK_EQ(start.name, "kyp.refresh");
  CHECK(!start.child_of_current);
  CHECK(*find(start.attributes, "kyp.refresh.trigger") == S("start"));
  CHECK(*find(start.attributes, "kyp.refresh.result") == S("updated"));
  CHECK(*find(start.attributes, "kyp.revision") == I(1));
  CHECK(*find(start.attributes, "kyp.workspace") == S("acme"));
  CHECK(*find(start.attributes, "kyp.source") == S("snapshot"));
  CHECK(*find(start.attributes, "kyp.mirror") == S("snapshot"));
  CHECK(start.events == (std::vector<std::string>{"kyp.fallback", "kyp.update"}));
  CHECK(start.ended);
  auto& update = *spans[2];
  CHECK(update.child_of_current);
  CHECK(*find(update.attributes, "kyp.refresh.trigger") == S("manual"));
  CHECK(*find(update.attributes, "kyp.revision") == I(2));
  auto& bad = *spans[3];
  CHECK(*find(bad.attributes, "kyp.refresh.result") == S("failed"));
  CHECK(*find(bad.attributes, "error.type") == S("blob_unavailable"));
  CHECK(find(bad.attributes, "kyp.source") == nullptr);
  CHECK(!bad.error.empty());
  CHECK(std::find(bad.events.begin(), bad.events.end(), "kyp.hash_mismatch") != bad.events.end());

  CHECK_EQ(meter->count("kyp.refresh.duration"), 4u);
  CHECK_EQ(meter->count("kyp.fallbacks"), 5u);  // broken x4 + the tampered snapshot
  CHECK_EQ(meter->count("kyp.hash_mismatches"), 1u);
  {
    std::lock_guard<std::mutex> lk(meter->mu);
    auto& fb = meter->counters[0].second;
    CHECK(*find(fb, "kyp.app") == S("support-bot"));
    CHECK(*find(fb, "kyp.mirror") == S("broken"));
    CHECK(*find(fb, "kyp.source") == S("snapshot"));
    CHECK(*find(fb, "error.type") == S("bad_manifest"));
  }
  CHECK_THROWS_AS(f.client->render("greeting", {}), kyp::MissingVariable);
  CHECK_EQ(meter->count("kyp.render.errors"), 1u);

  auto g = kyp::tracing::gauge_values(*f.client);
  CHECK_EQ(g.revision, 2);
  CHECK(g.staleness_seconds >= 0);
  CHECK(*find(g.attributes, "kyp.env") == S("prod"));
}

TEST(adapter_skips_uneventful_rounds_unless_asked) {
  auto tracer = std::make_shared<FakeTracer>();
  auto meter = std::make_shared<FakeMeter>();
  {
    Fixture f(std::make_shared<kyp::tracing::Instrumentation>(tracer, meter), nullptr, true);
    CHECK(eventually([&] { return meter->count("kyp.refresh.duration") >= 2; }));
    f.client->refresh_now();
    CHECK_EQ(tracer->all().size(), 1u);  // the start-up round only
    CHECK_EQ(meter->count("kyp.refresh.duration"), 3u);
  }
  auto tracer2 = std::make_shared<FakeTracer>();
  kyp::tracing::InstrumentationOptions o;
  o.trace_all_refreshes = true;
  Fixture f(std::make_shared<kyp::tracing::Instrumentation>(tracer2, nullptr, o), nullptr, true);
  CHECK(eventually([&] { return tracer2->all().size() >= 2; }));
  f.client->refresh_now();
  CHECK_EQ(tracer2->all().size(), 3u);
  CHECK(*find(tracer2->all()[2]->attributes, "kyp.refresh.result") == S("not_modified"));
}

TEST(annotate_through_a_callback) {
  auto rec = std::make_shared<Recorder>();
  Fixture f(rec, rec.get());
  std::map<std::string, AttrValue> span;
  auto set = [&](const std::string& k, const AttrValue& v) { span[k] = v; };
  kyp::tracing::AnnotateOptions off;
  off.capture_content = false;
  kyp::Vars vars{{"name", "Ada"}, {"company", "Acme \"Corp\""}};
  off.variables = &vars;
  kyp::PromptMeta m = kyp::tracing::annotate(*f.client, "greeting", set, off);
  CHECK_EQ(span.size(), 10u);
  CHECK(span["kyp.prompt.version"] == I(1));
  CHECK(span["gen_ai.prompt.version"] == S("1"));
  CHECK(span["kyp.prompt.sha256"] == AttrValue(m.sha256));
  CHECK(!span.count("kyp.prompt.template"));

  span.clear();
  kyp::tracing::AnnotateOptions on;
  on.capture_content = true;
  on.open_inference = true;
  on.variables = &vars;
  kyp::tracing::annotate(*f.client, "greeting", set, on);
  CHECK(span["kyp.prompt.template"] == S("Hello {{name}} from {{company}}"));
  CHECK(span["gen_ai.prompt.variable.name"] == S("Ada"));
  CHECK(span["gen_ai.prompt.variable.company"] == S("Acme \"Corp\""));
  CHECK(span["prompt.vendor"] == S("keepyourprompts"));
  CHECK(span["prompt.id"] == S("support-bot/prod/greeting"));
  CHECK(span["llm.prompt_template.version"] == S("1"));
  std::string json = kyp::to_string(span["llm.prompt_template.variables"]);
  CHECK(json.find("\"name\":\"Ada\"") != std::string::npos);
  CHECK(json.find("\"company\":\"Acme \\\"Corp\\\"\"") != std::string::npos);

  span.clear();
  kyp::tracing::AnnotateOptions plain;
  plain.capture_content = false;
  plain.gen_ai_attributes = false;
  kyp::tracing::annotate(m, set, plain);
  CHECK_EQ(span.size(), 8u);
  CHECK_THROWS_AS(kyp::tracing::annotate(*f.client, "nope", set), kyp::NotFound);
}

CHECK_MAIN
