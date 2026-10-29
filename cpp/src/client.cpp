// Client: mirrors, background refresh and the lock-free read path.
#include "internal.hpp"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <random>
#include <thread>
#include <unordered_map>

namespace fs = std::filesystem;
using steady = std::chrono::steady_clock;
using sysclock = std::chrono::system_clock;
using std::chrono::milliseconds;

namespace kyp {
namespace detail {

// Immutable once published. Readers hold it through a shared_ptr.
struct State {
  Manifest manifest;
  std::string raw_manifest;
  std::vector<Prompt> prompts;  // never resized after the index is built
  std::unordered_map<std::string_view, const Prompt*> index;
  std::unordered_map<std::string_view, const std::string*> by_sha;
};

namespace {

// Globally unique generation numbers: a value names one state of one client.
std::atomic<std::uint64_t> g_next_gen{1};

std::string join_url(const std::string& base, const std::string& rel) {
  if (!base.empty() && base.back() == '/') return base + rel;
  return base + "/" + rel;
}

const char* level_name(LogLevel l) {
  switch (l) {
    case LogLevel::debug: return "debug";
    case LogLevel::info: return "info";
    case LogLevel::warn: return "warn";
    case LogLevel::error: return "error";
  }
  return "?";
}

std::string getenv_str(const char* name) {
  const char* v = std::getenv(name);
  return v ? std::string(v) : std::string();
}

}  // namespace

struct MirrorRt {
  Mirror cfg;
  MirrorKind kind = MirrorKind::file;
  std::string shown_url;
  // Guarded by Engine::refresh_mu.
  std::string etag;
  // Guarded by Engine::status_mu.
  int failures = 0;
  steady::time_point retry_at{};
  std::string last_error;
  std::optional<sysclock::time_point> last_ok;
};

// Everything except the read path and the thread: shared by Client and pull_snapshot.
struct Engine {
  enum class Outcome { updated, unchanged, stale, failed };

  Options o;
  std::vector<MirrorRt> mirrors;
  std::vector<std::size_t> polled;
  std::optional<std::size_t> cache_idx;
  std::unique_ptr<HttpClient> http;
  std::atomic<bool> stop{false};

  std::mutex refresh_mu;  // one refresh round at a time; guards etags, cache_root, http
  fs::path cache_root;

  mutable std::mutex status_mu;
  sysclock::time_point started = sysclock::now();
  std::optional<sysclock::time_point> last_success;
  std::string last_error;
  std::string source;

  explicit Engine(Options opts, bool for_snapshot = false) : o(std::move(opts)) {
    if (o.app_.empty()) throw Error("kyp: app is not set (Options::app or KYP_APP)");
    if (!is_slug(o.app_)) throw Error("kyp: app \"" + o.app_ + "\" is not a slug ([a-z0-9][a-z0-9-]{0,62})");
    if (!is_slug(o.env_)) throw Error("kyp: env \"" + o.env_ + "\" is not a slug ([a-z0-9][a-z0-9-]{0,62})");
    for (char c : o.delivery_key_)
      if (!std::isalnum(static_cast<unsigned char>(c)) && c != '_' && c != '-')
        throw Error("kyp: the delivery key contains an invalid character");
    if (!o.delivery_key_.empty() && o.delivery_key_.rfind("kypd_", 0) != 0)
      log(LogLevel::warn, "delivery key does not start with kypd_; check KYP_DELIVERY_KEY");
    if (o.poll_interval_ < milliseconds(100)) o.poll_interval_ = milliseconds(100);
    if (for_snapshot) {
      o.embedded_ = false;
      o.cache_dir_.clear();
    }

    auto add = [&](Mirror m, MirrorKind kind) {
      MirrorRt r;
      r.kind = kind;
      r.shown_url = redact(m.url, o.delivery_key_);
      r.cfg = std::move(m);
      mirrors.push_back(std::move(r));
    };
    std::vector<Mirror> rest;
    if (o.explicit_mirrors_) {
      rest = o.mirrors_;
    } else {
      if (!o.snapshot_dir_.empty()) rest.push_back(Mirror::file(o.snapshot_dir_, "snapshot"));
      if (!o.delivery_key_.empty()) {
        rest.push_back(Mirror::http(join_url(o.cdn_base_, o.delivery_key_), "cdn"));
        rest.push_back(Mirror::http(join_url(o.origin_base_, o.delivery_key_), "origin"));
      }
      if (!o.git_url_.empty()) rest.push_back(Mirror::http(o.git_url_, "git", o.git_token_));
    }
    for (auto& m : o.extra_mirrors_) rest.push_back(m);

    bool has_explicit_embedded = std::any_of(rest.begin(), rest.end(), [](const Mirror& m) {
      return mirror_kind(m.url) == MirrorKind::embedded;
    });
    if (o.embedded_ && !has_explicit_embedded && has_embedded(manifest_path()))
      add(Mirror::embedded(), MirrorKind::embedded);

    bool cache_added = false;
    auto add_cache = [&] {
      cache_idx = mirrors.size();
      add(Mirror{"disk-cache", o.cache_dir_.string(), {}}, MirrorKind::cache);
      cache_added = true;
    };
    for (auto& m : rest) {
      MirrorKind k = mirror_kind(m.url);
      if (k == MirrorKind::embedded && !o.embedded_) continue;
      if (!cache_added && !o.cache_dir_.empty() && k == MirrorKind::http) add_cache();
      add(m, k);
    }
    if (!cache_added && !o.cache_dir_.empty()) add_cache();

    for (std::size_t i = 0; i < mirrors.size(); ++i)
      if (mirrors[i].kind == MirrorKind::http) polled.push_back(i);
    if (!polled.empty()) {
      http = std::make_unique<HttpClient>(HttpSettings{o.connect_timeout_, o.request_timeout_, o.user_agent_});
      if (!HttpClient::available())
        log(LogLevel::warn, "HTTP mirrors are configured but this build has KYP_WITH_CURL=OFF");
    } else {
      // No network mirrors: poll the file mirrors (e.g. a snapshot folder kept
      // fresh by a sidecar or git pull).
      for (std::size_t i = 0; i < mirrors.size(); ++i)
        if (mirrors[i].kind == MirrorKind::file) polled.push_back(i);
    }
  }

  virtual ~Engine() = default;

  // Accessors for Client::Impl (friendship is not inherited).
  bool start_empty() const { return o.start_empty_; }
  milliseconds startup_timeout() const { return o.startup_timeout_; }
  milliseconds poll_interval() const { return o.poll_interval_; }
  bool has_on_update() const { return static_cast<bool>(o.on_update_); }
  void call_on_update(const Update& u) const { o.on_update_(u); }

  std::string manifest_path() const { return "envs/" + o.app_ + "/" + o.env_ + ".json"; }
  std::string what() const { return o.app_ + "/" + o.env_; }

  void log(LogLevel level, const std::string& msg) const {
    if (o.log_off_ || level < o.log_level_) return;
    std::string m = redact(msg, o.delivery_key_);
    if (o.logger_) {
      try {
        o.logger_(level, m);
      } catch (...) {
      }
    } else {
      std::cerr << "[kyp] " << level_name(level) << ": " << m << '\n';
    }
  }

  // --- mirror access ---------------------------------------------------------
  FetchResult fetch(std::size_t mi, const std::string& rel, const std::string& etag, steady::time_point deadline) {
    const MirrorRt& m = mirrors[mi];
    FetchResult r;
    switch (m.kind) {
      case MirrorKind::embedded:
        r = read_embedded(rel);
        break;
      case MirrorKind::file:
        r = read_file(file_url_to_path(m.cfg.url) / rel);
        break;
      case MirrorKind::cache:
        if (cache_root.empty()) {
          r.kind = FetchResult::not_found;
          r.error = "empty";
        } else {
          r = read_file(cache_root / rel);
        }
        break;
      case MirrorKind::http:
        r = http ? http->get(join_url(m.cfg.url, rel), etag, m.cfg.bearer_token, deadline, &stop)
                 : FetchResult{FetchResult::failed, {}, {}, "no HTTP client"};
        break;
    }
    if (!r.error.empty()) r.error = redact(r.error, o.delivery_key_);
    return r;
  }

  bool in_backoff(std::size_t mi) const {
    std::lock_guard<std::mutex> lk(status_mu);
    return mirrors[mi].retry_at > steady::now();
  }

  void record_ok(std::size_t mi) {
    bool recovered = false;
    {
      std::lock_guard<std::mutex> lk(status_mu);
      MirrorRt& m = mirrors[mi];
      recovered = m.failures > 0;
      m.failures = 0;
      m.retry_at = {};
      m.last_error.clear();
      m.last_ok = sysclock::now();
    }
    if (recovered) log(LogLevel::info, mirrors[mi].cfg.name + " is answering again");
  }

  void record_fail(std::size_t mi, const std::string& err, bool count) {
    int failures = 0;
    {
      std::lock_guard<std::mutex> lk(status_mu);
      MirrorRt& m = mirrors[mi];
      m.last_error = err;
      if (count) {
        failures = ++m.failures;
        // Skip the mirror for 0, 1, 3, 7, ... poll intervals, capped at max_backoff.
        auto poll = o.poll_interval_.count();
        long long mult = (1LL << std::min(failures - 1, 20)) - 1;
        long long ms = std::min<long long>(poll * mult, o.max_backoff_.count());
        thread_local std::mt19937 rng(std::random_device{}());
        double jitter = std::uniform_real_distribution<double>(0.9, 1.1)(rng);
        m.retry_at = steady::now() + milliseconds(static_cast<long long>(ms * jitter));
      }
    }
    if (failures == 1)
      log(LogLevel::warn, mirrors[mi].cfg.name + ": " + err);
    else
      log(LogLevel::debug, mirrors[mi].cfg.name + ": " + err);
  }

  // --- loading -----------------------------------------------------------------
  bool resolve_blob(std::size_t mi, const std::string& sha, steady::time_point dl, std::string& out,
                    std::string& err) {
    std::vector<std::size_t> order;
    if (cache_idx) order.push_back(*cache_idx);
    order.push_back(mi);
    for (std::size_t i = 0; i < mirrors.size(); ++i) order.push_back(i);
    std::vector<bool> seen(mirrors.size(), false);
    std::string errors;
    for (std::size_t i : order) {
      if (seen[i]) continue;
      seen[i] = true;
      if (stop.load()) break;
      if (i != mi && mirrors[i].kind == MirrorKind::http && in_backoff(i)) continue;
      FetchResult r = fetch(i, "blobs/" + sha, {}, dl);
      if (r.kind != FetchResult::ok) {
        if (i == mi) errors += mirrors[i].cfg.name + ": " + r.error + "; ";
        continue;
      }
      if (sha256_hex(r.body) != sha) {
        std::string msg = "blob " + sha.substr(0, 12) + " failed sha256 verification";
        log(LogLevel::warn, mirrors[i].cfg.name + ": " + msg + " (discarded)");
        errors += mirrors[i].cfg.name + ": " + msg + "; ";
        continue;
      }
      out = std::move(r.body);
      return true;
    }
    err = "blob " + sha.substr(0, 12) + " unavailable" + (errors.empty() ? "" : " (" + errors.substr(0, errors.size() - 2) + ")");
    return false;
  }

  std::shared_ptr<State> build(std::size_t mi, Manifest man, std::string raw, const State* cur,
                               steady::time_point dl, std::string& err) {
    auto st = std::make_shared<State>();
    st->manifest = std::move(man);
    st->raw_manifest = std::move(raw);
    st->prompts.reserve(st->manifest.prompts.size());
    std::unordered_map<std::string, std::string> fetched;
    for (const auto& [name, mp] : st->manifest.prompts) {
      std::string text;
      bool have = false;
      if (cur) {
        auto it = cur->by_sha.find(mp.sha256);
        if (it != cur->by_sha.end()) {
          text = *it->second;
          have = true;
        }
      }
      if (!have) {
        auto f = fetched.find(mp.sha256);
        if (f != fetched.end()) {
          text = f->second;
        } else if (!resolve_blob(mi, mp.sha256, dl, text, err)) {
          return nullptr;
        } else {
          fetched.emplace(mp.sha256, text);
        }
      }
      Prompt p;
      p.name = name;
      p.version = mp.version;
      p.sha256 = mp.sha256;
      p.variables = mp.variables.empty() ? variables_in(text) : mp.variables;
      p.text = std::move(text);
      st->prompts.push_back(std::move(p));
    }
    for (const Prompt& p : st->prompts) {
      st->index.emplace(p.name, &p);
      st->by_sha.emplace(p.sha256, &p.text);
    }
    return st;
  }

  struct Candidate {
    std::shared_ptr<State> state;
    std::string etag;
    bool missing = false;
  };

  Outcome try_mirror(std::size_t mi, const State* cur, bool use_etag, steady::time_point dl, Candidate& out,
                     std::string& err) {
    std::string etag = (use_etag && cur) ? mirrors[mi].etag : std::string();
    FetchResult r = fetch(mi, manifest_path(), etag, dl);
    if (r.kind == FetchResult::not_modified) {
      out.etag = r.etag;
      return Outcome::unchanged;
    }
    if (r.kind != FetchResult::ok) {
      out.missing = r.kind == FetchResult::not_found;
      err = r.kind == FetchResult::not_found ? "manifest not found (" + r.error + ")" : r.error;
      return Outcome::failed;
    }
    Manifest man;
    try {
      man = parse_manifest(r.body, o.app_, o.env_);
    } catch (const std::exception& e) {
      err = std::string("bad manifest: ") + e.what();
      return Outcome::failed;
    }
    if (cur && man.revision < cur->manifest.revision) {
      err = "stale manifest ignored (revision " + std::to_string(man.revision) + " < held " +
            std::to_string(cur->manifest.revision) + ")";
      return Outcome::stale;
    }
    if (cur && man.revision == cur->manifest.revision) {
      out.etag = r.etag;
      return Outcome::unchanged;
    }
    auto st = build(mi, std::move(man), std::move(r.body), cur, dl, err);
    if (!st) return Outcome::failed;
    out.state = std::move(st);
    out.etag = r.etag;
    return Outcome::updated;
  }

  // --- disk cache ----------------------------------------------------------
  fs::path cache_root_for(const std::string& workspace) const {
    return o.cache_dir_ / workspace / o.app_ / o.env_;
  }

  // Finds <cache_dir>/<workspace>/<app>/<env> holding the highest revision.
  void locate_cache() {
    if (!cache_idx || !cache_root.empty()) return;
    if (!o.workspace_.empty()) {
      cache_root = cache_root_for(o.workspace_);
      return;
    }
    std::error_code ec;
    std::int64_t best = -1;
    for (fs::directory_iterator it(o.cache_dir_, ec), end; !ec && it != end; it.increment(ec)) {
      fs::path root = it->path() / o.app_ / o.env_;
      FetchResult r = read_file(root / manifest_path());
      if (r.kind != FetchResult::ok) continue;
      try {
        Manifest m = parse_manifest(r.body, o.app_, o.env_);
        if (m.revision > best) {
          best = m.revision;
          cache_root = root;
        }
      } catch (const std::exception&) {
      }
    }
  }

  void write_cache(const State& st) {
    if (!cache_idx) return;
    fs::path root = cache_root_for(st.manifest.workspace);
    try {
      for (const Prompt& p : st.prompts) {
        fs::path blob = root / "blobs" / p.sha256;
        std::error_code ec;
        if (!fs::exists(blob, ec)) atomic_write(blob, p.text);
      }
      fs::path mpath = root / manifest_path();
      FetchResult existing = read_file(mpath);
      if (existing.kind == FetchResult::ok) {
        if (existing.body == st.raw_manifest) {
          cache_root = root;
          return;
        }
        try {
          if (parse_manifest(existing.body, o.app_, o.env_).revision > st.manifest.revision) return;
        } catch (const std::exception&) {
        }
      }
      atomic_write(mpath, st.raw_manifest);
      cache_root = root;
    } catch (const std::exception& e) {
      log(LogLevel::warn, std::string("disk cache write failed: ") + e.what());
    }
  }
};

}  // namespace detail

// =============================================================================
// Client::Impl
// =============================================================================
struct Client::Impl : detail::Engine {
  using State = detail::State;

  // Canonical pointer, published with std::atomic_store and read with
  // std::atomic_load (C++17 free functions). gen changes on every publish so
  // readers can keep a thread-local copy and skip the shared_ptr traffic.
#if defined(__cpp_lib_atomic_shared_ptr) && __cplusplus >= 202002L
  std::atomic<std::shared_ptr<const State>> state_;
  std::shared_ptr<const State> load() const { return state_.load(std::memory_order_acquire); }
  void publish(std::shared_ptr<const State> s) { state_.store(std::move(s), std::memory_order_release); }
#else
  std::shared_ptr<const State> state_;
  std::shared_ptr<const State> load() const { return std::atomic_load(&state_); }
  void publish(std::shared_ptr<const State> s) { std::atomic_store(&state_, std::move(s)); }
#endif
  std::atomic<std::uint64_t> gen_{detail::g_next_gen.fetch_add(1)};

  std::mutex pending_mu_;
  std::vector<Update> pending_;

  std::thread thread_;
  std::mutex wake_mu_;
  std::condition_variable wake_cv_;

  explicit Impl(Options opts) : Engine(std::move(opts)) {
    load_local();
    bool loaded_locally = static_cast<bool>(load());
    if (!loaded_locally) {
      if (polled.empty()) {
        if (!start_empty())
          throw Unavailable("kyp: no prompts for " + what() +
                            ": no snapshot or disk cache found and no remote mirror configured "
                            "(set KYP_DELIVERY_KEY, KYP_SNAPSHOT_DIR or embed a snapshot)");
        log(LogLevel::warn, "starting empty: no mirror for " + what());
      } else {
        startup_from_network();
      }
    }
    if (!polled.empty()) thread_ = std::thread([this, loaded_locally] { run(loaded_locally || !load()); });
  }

  ~Impl() override { close(); }

  void close() {
    {
      std::lock_guard<std::mutex> lk(wake_mu_);
      stop.store(true);
    }
    wake_cv_.notify_all();
    if (thread_.joinable()) thread_.join();
  }

  // Read path: one atomic load and a compare when nothing changed.
  const State* current() const {
    struct Cached {
      std::uint64_t gen = 0;
      std::shared_ptr<const State> state;
    };
    thread_local Cached tl;
    std::uint64_t g = gen_.load(std::memory_order_acquire);
    if (tl.gen != g) {
      tl.state = load();
      tl.gen = g;
    }
    return tl.state.get();
  }

  void install(std::shared_ptr<const State> st, std::size_t mi, bool notify) {
    std::shared_ptr<const State> old = load();
    publish(st);
    gen_.store(detail::g_next_gen.fetch_add(1), std::memory_order_release);
    {
      std::lock_guard<std::mutex> lk(status_mu);
      source = mirrors[mi].cfg.name;
    }
    log(LogLevel::info, "loaded " + what() + " revision " + std::to_string(st->manifest.revision) + " (" +
                            std::to_string(st->prompts.size()) + " prompts) from " + mirrors[mi].cfg.name);
    if (notify && has_on_update()) {
      Update u;
      u.old_revision = old ? old->manifest.revision : 0;
      u.new_revision = st->manifest.revision;
      u.source = mirrors[mi].cfg.name;
      for (const Prompt& p : st->prompts) {
        const Prompt* before = nullptr;
        if (old) {
          auto it = old->index.find(p.name);
          if (it != old->index.end()) before = it->second;
        }
        if (!before || before->sha256 != p.sha256) u.changed.push_back(p.name);
      }
      if (old)
        for (const Prompt& p : old->prompts)
          if (!st->index.count(p.name)) u.changed.push_back(p.name);
      std::lock_guard<std::mutex> lk(pending_mu_);
      pending_.push_back(std::move(u));
    }
  }

  void deliver_updates() {
    std::vector<Update> todo;
    {
      std::lock_guard<std::mutex> lk(pending_mu_);
      todo.swap(pending_);
    }
    for (const Update& u : todo) {
      try {
        call_on_update(u);
      } catch (const std::exception& e) {
        log(LogLevel::error, std::string("on_update callback threw: ") + e.what());
      } catch (...) {
        log(LogLevel::error, "on_update callback threw");
      }
    }
  }

  // Start-up step 1: local mirrors only (embedded, snapshot, disk cache). The
  // highest revision wins; ties go to the earlier mirror.
  void load_local() {
    std::lock_guard<std::mutex> lk(refresh_mu);
    locate_cache();
    std::shared_ptr<State> best;
    std::size_t best_mi = 0;
    for (std::size_t mi = 0; mi < mirrors.size(); ++mi) {
      if (mirrors[mi].kind == detail::MirrorKind::http) continue;
      Candidate c;
      std::string err;
      Outcome oc = try_mirror(mi, best.get(), false, steady::time_point::max(), c, err);
      if (oc == Outcome::updated) {
        best = c.state;
        best_mi = mi;
      } else if (oc == Outcome::failed && !c.missing) {
        record_fail(mi, err, false);
      }
    }
    if (best) {
      install(best, best_mi, false);
      if (best_mi != cache_idx.value_or(SIZE_MAX)) write_cache(*best);
    }
  }

  // Start-up step 2: nothing local, so block on the network up to startup_timeout.
  void startup_from_network() {
    auto deadline = steady::now() + startup_timeout();
    milliseconds delay(100);
    while (!load()) {
      {
        std::lock_guard<std::mutex> lk(refresh_mu);
        round(true, deadline);
      }
      if (load() || steady::now() + delay >= deadline) break;
      std::this_thread::sleep_for(delay);
      delay = std::min(delay * 2, milliseconds(1000));
    }
    {
      std::lock_guard<std::mutex> lk(pending_mu_);
      pending_.clear();  // the first load is not an "update"
    }
    if (load()) return;
    std::string err;
    {
      std::lock_guard<std::mutex> lk(status_mu);
      err = last_error;
    }
    if (!start_empty())
      throw Unavailable("kyp: could not load " + what() + " within " + std::to_string(startup_timeout().count()) +
                        " ms: " + err);
    log(LogLevel::warn, "starting empty, will keep trying: " + err);
  }

  // One refresh round over the polled mirrors, in order. Caller holds refresh_mu.
  bool round(bool ignore_backoff, steady::time_point dl) {
    std::shared_ptr<const State> cur = load();
    std::vector<std::string> errs;
    std::vector<std::size_t> skipped;
    auto attempt = [&](std::size_t mi) {
      Candidate c;
      std::string err;
      Outcome oc = try_mirror(mi, cur.get(), true, dl, c, err);
      const std::string& name = mirrors[mi].cfg.name;
      switch (oc) {
        case Outcome::updated:
          mirrors[mi].etag = c.etag;
          install(c.state, mi, true);
          write_cache(*c.state);
          record_ok(mi);
          return true;
        case Outcome::unchanged: {
          mirrors[mi].etag = c.etag;
          record_ok(mi);
          std::lock_guard<std::mutex> lk(status_mu);
          if (cur) source = name;
          return true;
        }
        case Outcome::stale:
          errs.push_back(name + ": " + err);
          record_fail(mi, err, false);
          return false;
        case Outcome::failed:
          errs.push_back(name + ": " + err);
          record_fail(mi, err, true);
          return false;
      }
      return false;
    };
    bool answered = false;
    for (std::size_t mi : polled) {
      if (stop.load()) break;
      if (!ignore_backoff && in_backoff(mi)) {
        skipped.push_back(mi);
        continue;
      }
      if ((answered = attempt(mi))) break;
    }
    // Everything we tried failed: give the mirrors in backoff a chance too.
    if (!answered)
      for (std::size_t mi : skipped) {
        if (stop.load()) break;
        if ((answered = attempt(mi))) break;
      }
    std::string joined;
    for (std::size_t i = 0; i < errs.size(); ++i) joined += (i ? "; " : "") + errs[i];
    {
      std::lock_guard<std::mutex> lk(status_mu);
      if (answered) last_success = sysclock::now();
      last_error = (!answered && joined.empty()) ? "all mirrors backing off" : joined;
    }
    if (!answered && !stop.load()) log(LogLevel::warn, "refresh failed, serving what is held: " + joined);
    return answered;
  }

  void run(bool immediate) {
    std::mt19937 rng(std::random_device{}());
    std::uniform_real_distribution<double> jitter(0.9, 1.1);
    bool first = immediate;
    while (!stop.load()) {
      if (!first) {
        auto wait = milliseconds(static_cast<long long>(poll_interval().count() * jitter(rng)));
        std::unique_lock<std::mutex> lk(wake_mu_);
        wake_cv_.wait_for(lk, wait, [&] { return stop.load(); });
        if (stop.load()) break;
      }
      first = false;
      {
        std::lock_guard<std::mutex> lk(refresh_mu);
        try {
          round(false, steady::time_point::max());
        } catch (const std::exception& e) {
          log(LogLevel::error, std::string("refresh error: ") + e.what());
        }
      }
      deliver_updates();
    }
  }

  const Prompt& find(std::string_view name) const {
    const State* s = current();
    if (s) {
      auto it = s->index.find(name);
      if (it != s->index.end()) return *it->second;
    }
    throw NotFound(std::string(name), s ? what() + " revision " + std::to_string(s->manifest.revision)
                                        : "nothing loaded for " + what());
  }
};

// =============================================================================
// Public API
// =============================================================================
Mirror Mirror::file(const std::filesystem::path& dir, std::string name) {
  return Mirror{std::move(name), dir.string(), {}};
}
Mirror Mirror::http(std::string base_url, std::string name, std::string bearer_token) {
  return Mirror{std::move(name), std::move(base_url), std::move(bearer_token)};
}
Mirror Mirror::embedded() { return Mirror{"embedded", "embedded:", {}}; }

Options Options::from_env() {
  using detail::getenv_str;
  Options o;
  o.app(getenv_str("KYP_APP"));
  if (auto v = getenv_str("KYP_ENV"); !v.empty()) o.env(v);
  o.delivery_key(getenv_str("KYP_DELIVERY_KEY"));
  o.workspace(getenv_str("KYP_WORKSPACE"));
  if (auto v = getenv_str("KYP_SNAPSHOT_DIR"); !v.empty()) o.snapshot_dir(v);
  if (auto v = getenv_str("KYP_CACHE_DIR"); !v.empty()) o.cache_dir(v);
  if (auto v = getenv_str("KYP_GIT_MIRROR"); !v.empty()) o.git_mirror(v, getenv_str("KYP_GIT_TOKEN"));
  if (auto v = getenv_str("KYP_CDN_URL"); !v.empty()) o.cdn_base(v);
  if (auto v = getenv_str("KYP_ORIGIN_URL"); !v.empty()) o.origin_base(v);
  if (auto v = getenv_str("KYP_POLL_INTERVAL"); !v.empty()) {
    char* end = nullptr;
    double secs = std::strtod(v.c_str(), &end);
    if (end != v.c_str() && secs > 0) o.poll_interval(milliseconds(static_cast<long long>(secs * 1000)));
  }
  std::string lvl = getenv_str("KYP_LOG");
  if (lvl == "off") o.log_off_ = true;
  else if (lvl == "debug") o.log_level(LogLevel::debug);
  else if (lvl == "info") o.log_level(LogLevel::info);
  else if (lvl == "error") o.log_level(LogLevel::error);
  return o;
}

Client::Client(Options options) : impl_(std::make_unique<Impl>(std::move(options))) {}
Client Client::from_env() { return Client(Options::from_env()); }
Client::Client(Client&&) noexcept = default;
Client& Client::operator=(Client&&) noexcept = default;
Client::~Client() = default;

std::string Client::get(std::string_view name) const { return impl_->find(name).text; }

std::optional<std::string> Client::try_get(std::string_view name) const {
  const detail::State* s = impl_->current();
  if (!s) return std::nullopt;
  auto it = s->index.find(name);
  if (it == s->index.end()) return std::nullopt;
  return it->second->text;
}

bool Client::contains(std::string_view name) const {
  const detail::State* s = impl_->current();
  return s && s->index.count(name) > 0;
}

Prompt Client::prompt(std::string_view name) const { return impl_->find(name); }

std::string Client::render(std::string_view name, const Vars& vars, OnMissing on_missing) const {
  return ::kyp::render(impl_->find(name).text, vars, on_missing);
}

std::vector<std::string> Client::names() const {
  std::vector<std::string> out;
  if (const detail::State* s = impl_->current())
    for (const Prompt& p : s->prompts) out.push_back(p.name);
  return out;
}

std::int64_t Client::revision() const {
  const detail::State* s = impl_->current();
  return s ? s->manifest.revision : 0;
}

Status Client::status() const {
  Status st;
  auto s = impl_->load();
  if (s) {
    st.ready = true;
    st.revision = s->manifest.revision;
    st.workspace = s->manifest.workspace;
    st.deployed_at = s->manifest.deployed_at;
    st.prompt_count = s->prompts.size();
  }
  std::lock_guard<std::mutex> lk(impl_->status_mu);
  st.source = impl_->source;
  st.last_success = impl_->last_success;
  st.last_error = impl_->last_error;
  auto since = impl_->last_success.value_or(impl_->started);
  st.stale_for = std::max(milliseconds(0), std::chrono::duration_cast<milliseconds>(sysclock::now() - since));
  for (const auto& m : impl_->mirrors)
    st.mirrors.push_back(MirrorStatus{m.cfg.name, m.shown_url, m.failures, m.last_error, m.last_ok});
  return st;
}

bool Client::refresh_now() {
  if (impl_->polled.empty() || impl_->stop.load()) return false;
  bool ok;
  {
    std::lock_guard<std::mutex> lk(impl_->refresh_mu);
    ok = impl_->round(true, steady::time_point::max());
  }
  impl_->deliver_updates();
  return ok;
}

void Client::close() {
  if (impl_) impl_->close();
}

SnapshotInfo pull_snapshot(const Options& options, const std::filesystem::path& out_dir) {
  detail::Engine e(options, /*for_snapshot=*/true);
  std::string errors;
  for (std::size_t mi : e.polled) {
    detail::Engine::Candidate c;
    std::string err;
    auto oc = e.try_mirror(mi, nullptr, false, steady::time_point::max(), c, err);
    if (oc != detail::Engine::Outcome::updated) {
      errors += (errors.empty() ? "" : "; ") + e.mirrors[mi].cfg.name + ": " + err;
      continue;
    }
    const detail::State& st = *c.state;
    SnapshotInfo info;
    info.workspace = st.manifest.workspace;
    info.revision = st.manifest.revision;
    info.prompt_count = st.prompts.size();
    info.source = e.mirrors[mi].cfg.name;
    for (const Prompt& p : st.prompts) {
      fs::path blob = out_dir / "blobs" / p.sha256;
      detail::FetchResult existing = detail::read_file(blob);
      if (existing.kind == detail::FetchResult::ok && existing.body == p.text) continue;
      detail::atomic_write(blob, p.text);
      ++info.blobs_written;
    }
    detail::atomic_write(out_dir / e.manifest_path(), st.raw_manifest);
    return info;
  }
  if (e.polled.empty()) errors = "no remote mirror configured (set a delivery key or --mirror)";
  throw Unavailable("kyp: could not pull " + e.what() + ": " + errors);
}

}  // namespace kyp
