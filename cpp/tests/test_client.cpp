// Client behaviour against file:// mirrors in a temp dir.
#include <kyp/kyp.hpp>

#include <atomic>
#include <mutex>
#include <set>
#include <thread>
#include <vector>

#include "check.hpp"
#include "util.hpp"

using kyp::Mirror;

TEST(loads_from_a_snapshot_and_reads_from_memory) {
  TempDir t;
  write_snapshot(t / "snap", snap(3, {{"triage", "Triage for {{company}} via {{ queue }}."},
                                     {"agents/reviewer", "Review carefully."}}));
  kyp::Client c(quiet_options().snapshot_dir(t / "snap"));
  CHECK_EQ(c.revision(), 3);
  CHECK_EQ(c.get("agents/reviewer"), "Review carefully.");
  CHECK_EQ(c.render("triage", {{"company", "Acme"}, {"queue", "refunds"}}), "Triage for Acme via refunds.");
  CHECK(c.contains("triage"));
  CHECK(!c.contains("nope"));
  CHECK(!c.try_get("nope").has_value());
  CHECK_EQ(*c.try_get("triage"), "Triage for {{company}} via {{ queue }}.");
  CHECK_THROWS_AS(c.get("nope"), kyp::NotFound);
  CHECK_THROWS_AS(c.render("triage", {{"company", "Acme"}}), kyp::MissingVariable);

  kyp::Prompt p = c.prompt("triage");
  CHECK_EQ(p.name, "triage");
  CHECK_EQ(p.version, 3);
  CHECK_EQ(p.sha256, kyp::sha256_hex(p.text));
  CHECK_EQ(p.variables.size(), 2u);  // derived from the text when the manifest omits them
  CHECK_EQ(p.variables[1], "queue");
  CHECK_EQ(c.names().size(), 2u);

  kyp::Status s = c.status();
  CHECK(s.ready);
  CHECK_EQ(s.source, "snapshot");
  CHECK_EQ(s.workspace, "acme");
  CHECK_EQ(s.prompt_count, 2u);
  CHECK_EQ(s.deployed_at, "2026-10-29T14:03:11Z");
}

TEST(mirror_fallback_order) {
  TempDir t;
  SnapshotSpec spec = snap(5, {{"p", "good"}});
  // m1: nothing there. m2: tampered blob. m3: good. m4: good, different body.
  auto bad = spec;
  bad.corrupt = {"p"};
  bad.prompts = {{"p", "tampered"}};
  write_snapshot(t / "m2", bad);
  write_snapshot(t / "m3", spec);
  auto other = spec;
  other.prompts = {{"p", "also good"}};
  write_snapshot(t / "m4", other);

  std::vector<std::string> logs;
  std::mutex mu;
  kyp::Client c(quiet_options()
                    .mirrors({Mirror::file(t / "m1", "m1"), Mirror::file(t / "m2", "m2"),
                              Mirror::file("file://" + (t / "m3").string(), "m3"), Mirror::file(t / "m4", "m4")})
                    .log_level(kyp::LogLevel::debug)
                    .logger([&](kyp::LogLevel, const std::string& m) {
                      std::lock_guard<std::mutex> lk(mu);
                      logs.push_back(m);
                    }));
  CHECK_EQ(c.get("p"), "good");
  CHECK_EQ(c.status().source, "m3");
  bool warned = false;
  std::lock_guard<std::mutex> lk(mu);
  for (auto& l : logs) warned |= l.find("failed sha256 verification") != std::string::npos;
  CHECK(warned);
}

TEST(startup_prefers_the_highest_local_revision) {
  TempDir t;
  write_snapshot(t / "old", snap(2, {{"p", "two"}}));
  write_snapshot(t / "new", snap(9, {{"p", "nine"}}));
  kyp::Client c(quiet_options().mirrors({Mirror::file(t / "old", "old"), Mirror::file(t / "new", "new")}));
  CHECK_EQ(c.revision(), 9);
  CHECK_EQ(c.get("p"), "nine");
  CHECK_EQ(c.status().source, "new");
}

TEST(blob_hash_mismatch_is_rejected) {
  TempDir t;
  write_snapshot(t / "snap", snap(1, {{"p", "text"}}).corrupting("p"));
  CHECK_THROWS_AS(kyp::Client(quiet_options().snapshot_dir(t / "snap").startup_timeout(std::chrono::milliseconds(200))), kyp::Unavailable);

  kyp::Client empty(quiet_options().snapshot_dir(t / "snap").startup_timeout(std::chrono::milliseconds(200)).start_empty());
  CHECK(!empty.status().ready);
  CHECK_EQ(empty.revision(), 0);
  CHECK(!empty.try_get("p"));
  CHECK_THROWS_AS(empty.get("p"), kyp::NotFound);
}

TEST(nothing_configured_is_unavailable) {
  CHECK_THROWS_AS(kyp::Client(quiet_options()), kyp::Unavailable);
  CHECK_THROWS_AS(kyp::Client(quiet_options().app("")), kyp::Error);
  CHECK_THROWS_AS(kyp::Client(quiet_options().app("Bad App")), kyp::Error);
  CHECK_THROWS_AS(kyp::Client(quiet_options().app("x").delivery_key("kypd_../x")), kyp::Error);
}

TEST(refresh_swaps_in_a_new_revision_and_notifies) {
  TempDir t;
  write_snapshot(t / "m", snap(1, {{"a", "a1"}, {"b", "b1"}, {"gone", "x"}}));
  std::vector<kyp::Update> updates;
  std::mutex mu;
  kyp::Client c(quiet_options()
                    .mirrors({Mirror::file(t / "m", "m")})
                    .poll_interval(std::chrono::hours(1))
                    .on_update([&](const kyp::Update& u) {
                      std::lock_guard<std::mutex> lk(mu);
                      updates.push_back(u);
                    }));
  write_snapshot(t / "m", snap(2, {{"a", "a1"}, {"b", "b2"}, {"new", "n"}}));
  CHECK(c.refresh_now());
  CHECK_EQ(c.revision(), 2);
  CHECK_EQ(c.get("b"), "b2");
  CHECK(!c.contains("gone"));
  // The background thread may have won the race to deliver it.
  CHECK(eventually([&] {
    std::lock_guard<std::mutex> lk(mu);
    return updates.size() == 1;
  }));
  std::lock_guard<std::mutex> lk(mu);
  CHECK_EQ(updates[0].old_revision, 1);
  CHECK_EQ(updates[0].new_revision, 2);
  CHECK_EQ(updates[0].source, "m");
  std::set<std::string> changed(updates[0].changed.begin(), updates[0].changed.end());
  CHECK(changed == (std::set<std::string>{"b", "new", "gone"}));
}

TEST(lower_revision_is_rejected) {
  TempDir t;
  write_snapshot(t / "m", snap(7, {{"p", "seven"}}));
  kyp::Client c(quiet_options().mirrors({Mirror::file(t / "m", "m")}).poll_interval(std::chrono::hours(1)));
  write_snapshot(t / "m", snap(6, {{"p", "six"}}));
  CHECK(!c.refresh_now());
  CHECK_EQ(c.revision(), 7);
  CHECK_EQ(c.get("p"), "seven");
  CHECK(c.status().last_error.find("stale") != std::string::npos);
}

TEST(refresh_asks_mirrors_in_order_and_falls_back) {
  TempDir t;
  write_snapshot(t / "a", snap(1, {{"p", "one"}}));
  write_snapshot(t / "b", snap(1, {{"p", "one"}}));
  kyp::Client c(quiet_options()
                    .mirrors({Mirror::file(t / "a", "a"), Mirror::file(t / "b", "b")})
                    .poll_interval(std::chrono::hours(1)));
  CHECK_EQ(c.status().source, "a");
  // b gets ahead, but a still answers first with the revision we hold.
  write_snapshot(t / "b", snap(2, {{"p", "two"}}));
  CHECK(c.refresh_now());
  CHECK_EQ(c.revision(), 1);
  // a goes away: the next round falls back to b.
  fs::remove_all(t / "a");
  CHECK(c.refresh_now());
  CHECK_EQ(c.revision(), 2);
  CHECK_EQ(c.get("p"), "two");
  kyp::Status s = c.status();
  CHECK_EQ(s.source, "b");
  CHECK(s.last_error.find("a:") == 0);
  CHECK_EQ(s.mirrors.size(), 2u);
  CHECK(s.mirrors[0].consecutive_failures >= 1);
}

TEST(failures_never_evict_what_is_held) {
  TempDir t;
  write_snapshot(t / "m", snap(4, {{"p", "kept"}}));
  kyp::Client c(quiet_options().mirrors({Mirror::file(t / "m", "m")}).poll_interval(std::chrono::hours(1)));
  fs::remove_all(t / "m");
  CHECK(!c.refresh_now());
  CHECK(!c.refresh_now());
  CHECK_EQ(c.get("p"), "kept");
  kyp::Status s = c.status();
  CHECK(s.ready);
  CHECK(!s.last_error.empty());
  CHECK_EQ(s.revision, 4);
}

TEST(background_poll_picks_up_changes) {
  TempDir t;
  write_snapshot(t / "m", snap(1, {{"p", "v1"}}));
  kyp::Client c(quiet_options().mirrors({Mirror::file(t / "m", "m")}).poll_interval(std::chrono::milliseconds(100)));
  write_snapshot(t / "m", snap(2, {{"p", "v2"}}));
  CHECK(eventually([&] { return c.get("p") == "v2"; }));
  CHECK(c.status().last_success.has_value());
  CHECK(c.status().stale_for < std::chrono::seconds(2));
}

TEST(disk_cache_is_written_atomically_and_used_on_restart) {
  TempDir t;
  auto shas = write_snapshot(t / "m", snap(3, {{"p", "cached text"}}));
  {
    kyp::Client c(quiet_options().mirrors({Mirror::file(t / "m", "m")}).cache_dir(t / "cache"));
    CHECK_EQ(c.status().source, "m");
  }
  fs::path root = t / "cache" / "acme" / "support-bot" / "prod";
  CHECK(fs::exists(root / "envs" / "support-bot" / "prod.json"));
  CHECK_EQ(read_file(root / "blobs" / shas["p"]), "cached text");
  for (auto& e : fs::recursive_directory_iterator(t / "cache"))
    CHECK(e.path().filename().string().find(".tmp") == std::string::npos);

  // The mirror is gone: a restart comes up from the disk cache, found by scanning.
  fs::remove_all(t / "m");
  kyp::Client c2(quiet_options().mirrors({Mirror::file(t / "m", "m")}).cache_dir(t / "cache"));
  CHECK_EQ(c2.get("p"), "cached text");
  CHECK_EQ(c2.status().source, "disk-cache");
  // And with the workspace given explicitly.
  kyp::Client c3(quiet_options().workspace("acme").mirrors({Mirror::file(t / "m", "m")}).cache_dir(t / "cache"));
  CHECK_EQ(c3.revision(), 3);
}

TEST(tampered_disk_cache_is_ignored) {
  TempDir t;
  auto shas = write_snapshot(t / "m", snap(3, {{"p", "real"}}));
  { kyp::Client c(quiet_options().mirrors({Mirror::file(t / "m", "m")}).cache_dir(t / "cache")); }
  write_file(t / "cache" / "acme" / "support-bot" / "prod" / "blobs" / shas["p"], "evil");
  // Mirror still there: the bad cache blob is skipped and the mirror's copy is used.
  kyp::Client c(quiet_options().mirrors({Mirror::file(t / "m", "m")}).cache_dir(t / "cache"));
  CHECK_EQ(c.get("p"), "real");
}

TEST(atomic_swap_under_concurrent_readers) {
  TempDir t;
  auto body = [](int rev) { return "rev " + std::to_string(rev) + " " + std::string(200 + rev % 50, 'x'); };
  write_snapshot(t / "m", snap(1, {{"p", body(1)}, {"q", body(1)}}));
  kyp::Client c(quiet_options().mirrors({Mirror::file(t / "m", "m")}).poll_interval(std::chrono::hours(1)));

  std::atomic<bool> done{false};
  std::atomic<long> reads{0}, errors{0};
  std::vector<std::thread> readers;
  for (int i = 0; i < 8; ++i)
    readers.emplace_back([&] {
      std::int64_t last_rev = 0;
      while (!done.load()) {
        kyp::Prompt p = c.prompt("p");
        std::string g = c.get("q");
        std::int64_t rev = c.revision();
        bool ok = kyp::sha256_hex(p.text) == p.sha256 && p.text == body(static_cast<int>(p.version)) &&
                  g.rfind("rev ", 0) == 0 && rev >= last_rev && p.version >= last_rev;
        if (!ok) ++errors;
        last_rev = std::max(last_rev, p.version);
        ++reads;
      }
    });
  for (int rev = 2; rev <= 150; ++rev) {
    write_snapshot(t / "m", snap(rev, {{"p", body(rev)}, {"q", body(rev)}}));
    CHECK(c.refresh_now());
  }
  done = true;
  for (auto& r : readers) r.join();
  CHECK_EQ(errors.load(), 0);
  CHECK(reads.load() > 1000);
  CHECK_EQ(c.revision(), 150);
}

TEST(client_is_movable_and_close_is_idempotent) {
  TempDir t;
  write_snapshot(t / "m", snap(1, {{"p", "x"}}));
  kyp::Client a(quiet_options().mirrors({Mirror::file(t / "m", "m")}).poll_interval(std::chrono::milliseconds(100)));
  kyp::Client b(std::move(a));
  CHECK_EQ(b.get("p"), "x");
  b.close();
  b.close();
  CHECK_EQ(b.get("p"), "x");
  CHECK(!b.refresh_now());
}

TEST(options_from_env) {
  TempDir t;
  write_snapshot(t / "snap", snap(1, {{"p", "from env"}}).for_app("env-app", "staging"));
  setenv("KYP_APP", "env-app", 1);
  setenv("KYP_ENV", "staging", 1);
  setenv("KYP_SNAPSHOT_DIR", (t / "snap").c_str(), 1);
  setenv("KYP_LOG", "off", 1);
  unsetenv("KYP_DELIVERY_KEY");
  auto c = kyp::Client::from_env();
  CHECK_EQ(c.get("p"), "from env");
  unsetenv("KYP_APP");
  unsetenv("KYP_ENV");
  unsetenv("KYP_SNAPSHOT_DIR");
  unsetenv("KYP_LOG");
}

CHECK_MAIN
