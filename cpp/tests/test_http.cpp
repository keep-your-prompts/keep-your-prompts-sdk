// HTTP behaviour against tests/fake_cdn.py: ETag/304, hot reload, CDN -> origin
// fallback, disk cache restarts, start-up timeout, bearer tokens, kyp-snapshot.
//
//   test_http <python3> <fake_cdn.py> [kyp-snapshot]
// Exits 77 (skipped) when python3 is not available.
#include <kyp/kyp.hpp>

#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>

#include "check.hpp"
#include "internal.hpp"
#include "util.hpp"

using namespace std::chrono_literals;

static std::string g_python, g_script, g_tool;
static const std::string kKey = "kypd_Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4f";

struct Server {
  pid_t pid = -1;
  int port = 0;

  explicit Server(const std::vector<std::string>& routes) {
    int fds[2];
    if (pipe(fds) != 0) return;
    pid = fork();
    if (pid == 0) {
      dup2(fds[1], 1);
      close(fds[0]);
      std::vector<std::string> args{g_python, g_script};
      for (auto& r : routes) {
        args.push_back("--route");
        args.push_back(r);
      }
      std::vector<char*> argv;
      for (auto& a : args) argv.push_back(a.data());
      argv.push_back(nullptr);
      execvp(argv[0], argv.data());
      _exit(127);
    }
    close(fds[1]);
    FILE* f = fdopen(fds[0], "r");
    char line[64] = {0};
    if (f && std::fgets(line, sizeof line, f)) std::sscanf(line, "PORT %d", &port);
    if (f) std::fclose(f);
  }
  ~Server() {
    if (pid > 0) {
      kill(pid, SIGTERM);
      waitpid(pid, nullptr, 0);
    }
  }
  std::string base() const { return "http://127.0.0.1:" + std::to_string(port); }
  std::string ctl(const std::string& path) const {
    kyp::detail::HttpClient http({1000ms, 2000ms, "test"});
    return http.get(base() + path, "", "", std::chrono::steady_clock::time_point::max(), nullptr).body;
  }
  int stat(const std::string& route, const std::string& key) const {
    std::string s = ctl("/__stats");
    auto r = s.find("\"" + route + "\"");
    auto k = s.find("\"" + key + "\": ", r);
    return (r == std::string::npos || k == std::string::npos) ? -1 : std::atoi(s.c_str() + k + key.size() + 4);
  }
};

static std::vector<std::string> routes(const fs::path& cdn_dir, const fs::path& origin_dir) {
  return {"cdn:/v1/d/" + kKey + ":" + cdn_dir.string(), "origin:/v1/delivery/" + kKey + ":" + origin_dir.string()};
}

static kyp::Options http_options(const Server& s) {
  return quiet_options()
      .delivery_key(kKey)
      .cdn_base(s.base() + "/v1/d")
      .origin_base(s.base() + "/v1/delivery")
      .poll_interval(150ms)
      .max_backoff(400ms);
}

// Deploy like the server does: blobs first, then the manifest by rename.
static void deploy(const fs::path& dir, const SnapshotSpec& spec) {
  TempDir stage;
  write_snapshot(stage.path, spec);
  for (auto& e : fs::directory_iterator(stage / "blobs"))
    fs::copy_file(e.path(), dir / "blobs" / e.path().filename(), fs::copy_options::overwrite_existing);
  fs::create_directories(dir / "envs" / spec.app);
  fs::path tmp = dir / "envs" / spec.app / (spec.env + ".json.new");
  fs::copy_file(stage / "envs" / spec.app / (spec.env + ".json"), tmp, fs::copy_options::overwrite_existing);
  fs::rename(tmp, dir / "envs" / spec.app / (spec.env + ".json"));
}

TEST(loads_from_cdn_revalidates_with_etag_and_hot_reloads) {
  TempDir t;
  write_snapshot(t / "srv", snap(1, {{"triage", "v1 for {{company}}"}}));
  Server s(routes(t / "srv", t / "srv"));
  std::atomic<int> updates{0};
  auto start = std::chrono::steady_clock::now();
  kyp::Client c(http_options(s).cache_dir(t / "cache").on_update([&](const kyp::Update& u) {
    if (u.new_revision == 2 && !u.changed.empty() && u.changed[0] == "triage") ++updates;
  }));
  CHECK(std::chrono::steady_clock::now() - start < 3s);
  CHECK_EQ(c.render("triage", {{"company", "Acme"}}), "v1 for Acme");
  CHECK_EQ(c.status().source, "cdn");

  // Polls revalidate with If-None-Match and get 304s.
  CHECK(eventually([&] { return s.stat("cdn", "304") >= 2; }));
  CHECK_EQ(s.stat("origin", "200"), 0);

  // Deploy: the running client swaps it in without a restart.
  deploy(t / "srv", snap(2, {{"triage", "v2 for {{company}}"}}));
  CHECK(eventually([&] { return c.revision() == 2; }));
  CHECK_EQ(c.render("triage", {{"company", "Acme"}}), "v2 for Acme");
  CHECK(eventually([&] { return updates.load() == 1; }));

  // The disk cache follows.
  fs::path cached = t / "cache" / "acme" / "support-bot" / "prod" / "envs" / "support-bot" / "prod.json";
  CHECK(eventually([&] { return read_file(cached).find("\"revision\": 2") != std::string::npos; }));

  // The delivery key never shows up in status().
  for (const auto& m : c.status().mirrors) CHECK(m.url.find(kKey) == std::string::npos);
}

TEST(cdn_down_falls_back_to_origin_and_recovers) {
  TempDir t;
  write_snapshot(t / "srv", snap(1, {{"p", "one"}}));
  Server s(routes(t / "srv", t / "srv"));
  kyp::Client c(http_options(s));
  s.ctl("/__down/cdn");
  deploy(t / "srv", snap(2, {{"p", "two"}}));
  CHECK(eventually([&] { return c.revision() == 2; }));
  CHECK_EQ(c.get("p"), "two");
  CHECK(eventually([&] { return c.status().source == "origin"; }));
  CHECK(c.status().last_error.find("cdn: HTTP 503") != std::string::npos);

  s.ctl("/__up/cdn");
  CHECK(eventually([&] { return c.status().source == "cdn" && c.status().last_error.empty(); }));
}

TEST(everything_down_keeps_serving_and_restarts_from_disk_cache) {
  TempDir t;
  write_snapshot(t / "srv", snap(5, {{"p", "five"}}));
  Server s(routes(t / "srv", t / "srv"));
  kyp::Client c(http_options(s).cache_dir(t / "cache"));
  s.ctl("/__down/cdn");
  s.ctl("/__down/origin");
  CHECK(!c.refresh_now());
  CHECK_EQ(c.get("p"), "five");
  kyp::Status st = c.status();
  CHECK(st.last_error.find("origin: HTTP 503") != std::string::npos);

  // A restart with the network down comes up instantly from the disk cache.
  auto start = std::chrono::steady_clock::now();
  kyp::Client c2(http_options(s).cache_dir(t / "cache"));
  CHECK(std::chrono::steady_clock::now() - start < 500ms);
  CHECK_EQ(c2.get("p"), "five");
  CHECK_EQ(c2.status().source, "disk-cache");
}

TEST(startup_without_local_copy_times_out_or_starts_empty) {
  TempDir t;
  write_snapshot(t / "srv", snap(1, {{"p", "one"}}));
  Server s(routes(t / "srv", t / "srv"));
  s.ctl("/__down/cdn");
  s.ctl("/__down/origin");
  auto start = std::chrono::steady_clock::now();
  CHECK_THROWS_AS(kyp::Client(http_options(s).startup_timeout(400ms)), kyp::Unavailable);
  auto took = std::chrono::steady_clock::now() - start;
  CHECK(took >= 300ms);
  CHECK(took < 2s);

  kyp::Client c(http_options(s).startup_timeout(200ms).start_empty());
  CHECK(!c.status().ready);
  CHECK(!c.try_get("p"));
  s.ctl("/__up/origin");
  CHECK(eventually([&] { return c.try_get("p") == std::optional<std::string>("one"); }));
  CHECK_EQ(c.status().source, "origin");
}

TEST(unreachable_host_respects_startup_timeout) {
  // Nothing listens on port 9 (discard) on loopback: connection refused, fast.
  auto start = std::chrono::steady_clock::now();
  CHECK_THROWS_AS(kyp::Client(quiet_options()
                                  .delivery_key(kKey)
                                  .cdn_base("http://127.0.0.1:9/v1/d")
                                  .origin_base("http://127.0.0.1:9/v1/delivery")
                                  .startup_timeout(300ms)),
                  kyp::Unavailable);
  CHECK(std::chrono::steady_clock::now() - start < 2s);
}

TEST(tampered_cdn_blob_is_rejected_and_origin_used) {
  TempDir t;
  write_snapshot(t / "bad", snap(1, {{"p", "genuine"}}).corrupting("p"));
  write_snapshot(t / "good", snap(1, {{"p", "genuine"}}));
  Server s(routes(t / "bad", t / "good"));
  std::atomic<int> warnings{0};
  kyp::Client c(http_options(s).logger([&](kyp::LogLevel l, const std::string& m) {
    if (l == kyp::LogLevel::warn && m.find("failed sha256 verification") != std::string::npos) ++warnings;
  }));
  // The manifest comes from the CDN; the tampered blob is discarded and the
  // verified copy is taken from the next mirror.
  CHECK_EQ(c.get("p"), "genuine");
  CHECK(warnings.load() >= 1);
}

TEST(git_mirror_sends_bearer_token) {
  TempDir t;
  write_snapshot(t / "repo" / ".kyp", snap(8, {{"p", "from git"}}));
  Server s({"git:/acme/prompts/main/.kyp:" + (t / "repo" / ".kyp").string()});
  kyp::Client c(quiet_options().git_mirror(s.base() + "/acme/prompts/main/.kyp", "github_pat_test"));
  CHECK_EQ(c.get("p"), "from git");
  CHECK_EQ(c.status().source, "git");
  CHECK(s.ctl("/__stats").find("\"auth\": \"Bearer github_pat_test\"") != std::string::npos);
}

TEST(pull_snapshot_and_kyp_snapshot_tool) {
  TempDir t;
  auto shas = write_snapshot(t / "srv", snap(3, {{"a", "alpha {{x}}"}, {"b", "beta"}}));
  Server s(routes(t / "srv", t / "srv"));

  kyp::SnapshotInfo info = kyp::pull_snapshot(http_options(s), t / "lib-out");
  CHECK_EQ(info.revision, 3);
  CHECK_EQ(info.prompt_count, 2u);
  CHECK_EQ(info.blobs_written, 2u);
  CHECK_EQ(info.source, "cdn");
  CHECK_EQ(read_file(t / "lib-out" / "blobs" / shas["a"]), "alpha {{x}}");

  if (!g_tool.empty()) {
    std::string cmd = g_tool + " --app support-bot --env prod --out " + (t / "tool-out").string() + " --key " + kKey +
                      " --cdn " + s.base() + "/v1/d --origin " + s.base() + "/v1/delivery -q";
    CHECK_EQ(std::system(cmd.c_str()), 0);
    // The folder is a complete offline mirror.
    kyp::Client offline(quiet_options().snapshot_dir(t / "tool-out"));
    CHECK_EQ(offline.get("b"), "beta");
    CHECK_EQ(offline.revision(), 3);
    // Bad arguments fail loudly.
    CHECK(std::system((g_tool + " --app support-bot 2>/dev/null").c_str()) != 0);
  }
}

int main(int argc, char** argv) {
  if (argc < 3) {
    std::fprintf(stderr, "usage: test_http <python3> <fake_cdn.py> [kyp-snapshot]\n");
    return 2;
  }
  g_python = argv[1];
  g_script = argv[2];
  if (argc > 3) g_tool = argv[3];
  {
    Server probe({"x:/x:/nonexistent"});
    if (probe.port == 0) {
      std::printf("python3 not available (%s): skipping HTTP tests\n", g_python.c_str());
      return 77;
    }
  }
  return check::run();
}
