// Keep Your Prompts C++ SDK.
//
//   #include <kyp/kyp.hpp>
//   auto prompts = kyp::Client::from_env();
//   std::string p = prompts.render("triage", {{"company", "Acme"}});
//
// Implements the prompt delivery protocol v1 (docs/delivery-protocol.md):
// interchangeable mirrors with one layout, a manifest plus content-addressed
// blobs verified with SHA-256, ETag revalidation, a background refresher and an
// atomic in-memory swap. Reads (get, render, prompt) never do I/O.
#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <variant>
#include <vector>

#define KYP_VERSION_MAJOR 0
#define KYP_VERSION_MINOR 1
#define KYP_VERSION_PATCH 0
#define KYP_VERSION_STRING "0.1.0"

namespace kyp {

// ---------------------------------------------------------------------------
// Errors. Everything the SDK throws derives from kyp::Error.
// ---------------------------------------------------------------------------
class Error : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

// get()/prompt()/render() for a name that is not in the deployed manifest.
class NotFound : public Error {
 public:
  explicit NotFound(std::string name, const std::string& detail = {});
  const std::string& name() const noexcept { return name_; }

 private:
  std::string name_;
};

// No mirror could deliver a manifest during start-up (see Options::startup_timeout).
class Unavailable : public Error {
 public:
  using Error::Error;
};

// render() was called without a value for one or more {{variables}}.
class MissingVariable : public Error {
 public:
  explicit MissingVariable(std::vector<std::string> names);
  const std::vector<std::string>& names() const noexcept { return names_; }

 private:
  std::vector<std::string> names_;
};

// A mirror returned something that does not follow the protocol.
class ProtocolError : public Error {
 public:
  using Error::Error;
};

// ---------------------------------------------------------------------------
// Templates: {{name}} with optional spaces, {{{{ renders a literal {{.
// ---------------------------------------------------------------------------
using Vars = std::unordered_map<std::string, std::string>;

enum class OnMissing {
  error,  // throw kyp::MissingVariable (default)
  keep,   // leave {{name}} in the output
  empty,  // replace with ""
};

std::string render(std::string_view tmpl, const Vars& vars, OnMissing on_missing = OnMissing::error);

// Distinct variable names in order of first appearance.
std::vector<std::string> variables_in(std::string_view tmpl);

// Lowercase hex SHA-256 (in-repo implementation, no OpenSSL).
std::string sha256_hex(std::string_view data);

// ---------------------------------------------------------------------------
// A deployed prompt.
// ---------------------------------------------------------------------------
struct Prompt {
  std::string name;
  std::int64_t version = 0;
  std::string sha256;
  std::vector<std::string> variables;
  std::string text;  // the raw template

  std::string render(const Vars& vars, OnMissing on_missing = OnMissing::error) const {
    return ::kyp::render(text, vars, on_missing);
  }
};

// ---------------------------------------------------------------------------
// Observability (protocol/tracing.md). No dependency on any tracing library:
// <kyp/tracing.hpp> bridges these to any tracer, <kyp/otel.hpp> to OpenTelemetry.
// ---------------------------------------------------------------------------
using AttrValue = std::variant<std::string, std::int64_t>;
// Ordered (key, value) pairs: span attributes or a flat metadata map.
using Attributes = std::vector<std::pair<std::string, AttrValue>>;

std::string to_string(const AttrValue& v);

// Which deployed body a call used. Read from memory with Client::meta() or
// Client::render_with_meta(). Never holds prompt content.
struct PromptMeta {
  std::string name;
  std::int64_t version = 0;
  std::string sha256;
  std::string app, env;
  std::string workspace;    // from the manifest
  std::int64_t revision = 0;
  std::string source;       // embedded, snapshot, cache, cdn, origin, git or custom; "" before a load

  // kyp.* plus gen_ai.prompt.name / gen_ai.prompt.version (a string) unless gen_ai is
  // false. kyp.workspace and kyp.source are left out when empty.
  Attributes attributes(bool gen_ai = true) const;
  // Flat kyp_* keys (dots replaced by underscores) for any tool's free-form metadata.
  Attributes trace_metadata() const;
  // The same map, for a Langfuse observation's metadata / LangSmith run metadata.
  Attributes langfuse_metadata() const { return trace_metadata(); }
  Attributes langsmith_metadata() const { return trace_metadata(); }

  bool operator==(const PromptMeta& o) const {
    return name == o.name && version == o.version && sha256 == o.sha256 && app == o.app && env == o.env &&
           workspace == o.workspace && revision == o.revision && source == o.source;
  }
  bool operator!=(const PromptMeta& o) const { return !(*this == o); }
};

// What Client::render_with_meta() returns.
struct Rendered {
  std::string text;
  PromptMeta meta;
};

enum class RefreshTrigger { start, poll, manual };
enum class RefreshResult { updated, not_modified, failed };
const char* to_string(RefreshTrigger t);  // "start", "poll", "manual"
const char* to_string(RefreshResult r);   // "updated", "not_modified", "failed"

// A span event of a refresh round: kyp.fallback, kyp.hash_mismatch or kyp.update.
struct TelemetryEvent {
  std::string name;
  std::chrono::system_clock::time_point time;
  Attributes attributes;
  const AttrValue* attr(std::string_view key) const;
};

// One refresh round, passed to Observer::on_refresh().
struct RefreshRecord {
  std::string app, env;
  RefreshTrigger trigger = RefreshTrigger::poll;
  RefreshResult result = RefreshResult::failed;
  std::chrono::system_clock::time_point start_time;
  std::chrono::nanoseconds duration{0};
  std::string mirror;      // configured name of the mirror that answered ("" when failed)
  std::string source;      // its normalised kind ("" when failed)
  std::int64_t revision = 0;           // held after the round (0 when nothing)
  std::int64_t previous_revision = 0;  // held before it
  std::string workspace;
  std::string error;       // when failed: short message, delivery key redacted
  std::string error_type;  // when failed: low-cardinality error.type
  std::vector<TelemetryEvent> events;
};

// A failed render() / render_with_meta(), passed to Observer::on_render_error().
struct RenderError {
  std::string app, env, name;
  std::string error_type;  // "not_found" or "missing_variable"
};

// Receives delivery telemetry. Called outside the client's locks (refresh rounds
// on the refresher thread, or the caller of refresh_now() / render()); an
// exception thrown by an observer is caught and logged.
class Observer {
 public:
  virtual ~Observer() = default;
  virtual void on_refresh(const RefreshRecord&) {}
  virtual void on_render_error(const RenderError&) {}
};

using ObserverId = std::uint64_t;

// A mirror's configured name and kind ("embedded", "file", "cache", "http") to kyp.source.
std::string normalize_source(std::string_view name, std::string_view kind);
// A failure message to a low-cardinality error.type.
std::string classify_error(std::string_view message);

// ---------------------------------------------------------------------------
// Mirrors: every copy of a workspace uses the same layout
//   envs/<app>/<env>.json   blobs/<sha256>
// ---------------------------------------------------------------------------
struct Mirror {
  std::string name;          // shown in status() and logs, e.g. "cdn"
  std::string url;           // file:///dir, /dir, https://host/base, or "embedded:"
  std::string bearer_token;  // sent as Authorization: Bearer (git mirror, origin)

  static Mirror file(const std::filesystem::path& dir, std::string name = "snapshot");
  static Mirror http(std::string base_url, std::string name, std::string bearer_token = {});
  static Mirror embedded();  // the snapshot baked in with kyp_embed_snapshot()
};

enum class LogLevel { debug, info, warn, error };
using Logger = std::function<void(LogLevel, const std::string&)>;

// Passed to Options::on_update after a new revision was swapped in.
struct Update {
  std::int64_t old_revision = 0;  // 0 if nothing was loaded before
  std::int64_t new_revision = 0;
  std::string source;             // mirror that delivered it
  std::vector<std::string> changed;  // prompts added, removed or changed
};

struct MirrorStatus {
  std::string name;
  std::string url;  // delivery key redacted
  int consecutive_failures = 0;
  std::string last_error;
  std::optional<std::chrono::system_clock::time_point> last_success;
};

struct Status {
  bool ready = false;           // a manifest is loaded
  std::string source;           // mirror that served or last confirmed the current state
  std::int64_t revision = 0;
  std::string workspace;
  std::string deployed_at;
  std::size_t prompt_count = 0;
  // Last time a polled mirror confirmed the manifest (200 or 304).
  std::optional<std::chrono::system_clock::time_point> last_success;
  // Errors from the latest refresh round; empty when the first mirror answered.
  std::string last_error;
  // How long since freshness was last confirmed (since start-up if never).
  std::chrono::milliseconds stale_for{0};
  std::vector<MirrorStatus> mirrors;
};

namespace detail {
struct Engine;
}  // namespace detail

// ---------------------------------------------------------------------------
// Options: a fluent builder. Only app (and env, default "prod") are required.
// ---------------------------------------------------------------------------
class Options {
 public:
  Options() = default;

  // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV, KYP_SNAPSHOT_DIR, KYP_CACHE_DIR,
  // KYP_GIT_MIRROR, KYP_GIT_TOKEN, plus KYP_WORKSPACE, KYP_POLL_INTERVAL (seconds),
  // KYP_CDN_URL, KYP_ORIGIN_URL and KYP_LOG (debug|info|warn|error|off).
  static Options from_env();

  Options& app(std::string v) { app_ = std::move(v); return *this; }
  Options& env(std::string v) { env_ = std::move(v); return *this; }
  Options& delivery_key(std::string v) { delivery_key_ = std::move(v); return *this; }
  // Optional: lets the disk cache be found without scanning cache_dir.
  Options& workspace(std::string v) { workspace_ = std::move(v); return *this; }

  // Replace the snapshot/CDN/origin/git mirrors with an explicit ordered list.
  // The embedded snapshot and disk cache still apply when enabled.
  Options& mirrors(std::vector<Mirror> v) { mirrors_ = std::move(v); explicit_mirrors_ = true; return *this; }
  Options& add_mirror(Mirror m) { extra_mirrors_.push_back(std::move(m)); return *this; }

  Options& snapshot_dir(std::filesystem::path v) { snapshot_dir_ = std::move(v); return *this; }
  Options& cache_dir(std::filesystem::path v) { cache_dir_ = std::move(v); return *this; }
  Options& embedded_snapshot(bool enabled = true) { embedded_ = enabled; return *this; }
  Options& git_mirror(std::string base_url, std::string token = {}) {
    git_url_ = std::move(base_url); git_token_ = std::move(token); return *this;
  }
  Options& cdn_base(std::string v) { cdn_base_ = std::move(v); return *this; }
  Options& origin_base(std::string v) { origin_base_ = std::move(v); return *this; }

  Options& poll_interval(std::chrono::milliseconds v) { poll_interval_ = v; return *this; }
  Options& connect_timeout(std::chrono::milliseconds v) { connect_timeout_ = v; return *this; }
  Options& request_timeout(std::chrono::milliseconds v) { request_timeout_ = v; return *this; }
  Options& startup_timeout(std::chrono::milliseconds v) { startup_timeout_ = v; return *this; }
  Options& max_backoff(std::chrono::milliseconds v) { max_backoff_ = v; return *this; }
  // Start with no prompts instead of throwing kyp::Unavailable.
  Options& start_empty(bool v = true) { start_empty_ = v; return *this; }

  Options& user_agent(std::string v) { user_agent_ = std::move(v); return *this; }
  Options& on_update(std::function<void(const Update&)> cb) { on_update_ = std::move(cb); return *this; }
  Options& logger(Logger l) { logger_ = std::move(l); return *this; }
  Options& log_level(LogLevel l) { log_level_ = l; return *this; }
  // Delivery telemetry hook, registered before start-up so the start-up round
  // is reported too. May be called several times.
  Options& observer(std::shared_ptr<Observer> o) { observers_.push_back(std::move(o)); return *this; }

 private:
  friend struct detail::Engine;

  std::string app_, env_ = "prod", delivery_key_, workspace_;
  std::vector<Mirror> mirrors_, extra_mirrors_;
  bool explicit_mirrors_ = false;
  std::filesystem::path snapshot_dir_, cache_dir_;
  bool embedded_ = true;
  std::string git_url_, git_token_;
  std::string cdn_base_ = "https://cdn.keepyourprompts.com/v1/d";
  std::string origin_base_ = "https://api.keepyourprompts.com/v1/delivery";
  std::chrono::milliseconds poll_interval_{30000};
  std::chrono::milliseconds connect_timeout_{2000};
  std::chrono::milliseconds request_timeout_{5000};
  std::chrono::milliseconds startup_timeout_{3000};
  std::chrono::milliseconds max_backoff_{300000};
  bool start_empty_ = false;
  std::string user_agent_ = "kyp-cpp/" KYP_VERSION_STRING;
  std::function<void(const Update&)> on_update_;
  Logger logger_;  // empty = stderr
  LogLevel log_level_ = LogLevel::warn;
  bool log_off_ = false;
  std::vector<std::shared_ptr<Observer>> observers_;
};

// ---------------------------------------------------------------------------
// Client. Thread-safe. Reads never block on I/O; a background thread keeps the
// state fresh and the destructor stops it.
// ---------------------------------------------------------------------------
class Client {
 public:
  explicit Client(Options options);
  static Client from_env();

  Client(Client&&) noexcept;
  Client& operator=(Client&&) noexcept;
  Client(const Client&) = delete;
  Client& operator=(const Client&) = delete;
  ~Client();

  // Raw template. Throws kyp::NotFound.
  std::string get(std::string_view name) const;
  std::optional<std::string> try_get(std::string_view name) const;
  bool contains(std::string_view name) const;

  // Name, version, sha256, variables and text. Throws kyp::NotFound.
  Prompt prompt(std::string_view name) const;

  // Render a prompt. Throws kyp::NotFound or kyp::MissingVariable.
  std::string render(std::string_view name, const Vars& vars,
                     OnMissing on_missing = OnMissing::error) const;

  // Which deployed body `name` is (protocol/tracing.md). Memory only. Throws kyp::NotFound.
  PromptMeta meta(std::string_view name) const;
  // render() plus the metadata of the exact body rendered.
  Rendered render_with_meta(std::string_view name, const Vars& vars,
                            OnMissing on_missing = OnMissing::error) const;

  // Subscribe to delivery telemetry (refresh rounds, render errors).
  ObserverId add_observer(std::shared_ptr<Observer> observer);
  bool remove_observer(ObserverId id);

  const std::string& app() const;
  const std::string& env() const;

  std::vector<std::string> names() const;
  std::int64_t revision() const;  // 0 when nothing is loaded
  Status status() const;

  // Revalidate now across mirrors (ignores backoff). Blocks for at most one
  // round of requests. Returns true if a mirror answered.
  bool refresh_now();

  // Stop the background refresher. Reads keep working. Called by ~Client.
  void close();

  struct Impl;

 private:
  std::unique_ptr<Impl> impl_;
};

// Pull the deployed manifest and its blobs from the configured mirrors and write
// the layout to `out_dir` (what tools/kyp-snapshot does).
struct SnapshotInfo {
  std::string workspace;
  std::int64_t revision = 0;
  std::size_t prompt_count = 0;
  std::size_t blobs_written = 0;
  std::string source;
};
SnapshotInfo pull_snapshot(const Options& options, const std::filesystem::path& out_dir);

namespace detail {
// Called by the code kyp_embed_snapshot() generates.
void register_embedded_files(const char* const* paths, const unsigned char* const* data,
                             const std::size_t* sizes, std::size_t count) noexcept;
}  // namespace detail

}  // namespace kyp
