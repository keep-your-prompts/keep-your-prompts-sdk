// The fixture snapshot in tests/fixtures/snapshot is compiled into this binary
// with kyp_embed_snapshot(): no files, no network.
#include <kyp/kyp.hpp>

#include "check.hpp"
#include "util.hpp"

static kyp::Options demo() {
  return kyp::Options().app("demo").env("prod").logger([](kyp::LogLevel, const std::string&) {});
}

TEST(starts_from_the_embedded_snapshot) {
  kyp::Client c(demo());
  CHECK_EQ(c.revision(), 12);
  CHECK_EQ(c.status().source, "embedded");
  CHECK_EQ(c.render("greeting", {{"name", "Ada"}}), "Hello Ada, this prompt was compiled into the binary.");
  CHECK_EQ(c.prompt("greeting").version, 4);
  CHECK_EQ(c.get("empty"), "");  // an empty blob round-trips
}

TEST(embedded_can_be_disabled_or_listed_explicitly) {
  CHECK_THROWS_AS(kyp::Client(demo().embedded_snapshot(false)), kyp::Unavailable);
  kyp::Client c(demo().mirrors({kyp::Mirror::embedded()}));
  CHECK_EQ(c.status().source, "embedded");
}

TEST(no_embedded_snapshot_for_other_apps) {
  CHECK_THROWS_AS(kyp::Client(demo().app("other")), kyp::Unavailable);
}

TEST(a_newer_local_mirror_wins_over_the_embedded_one) {
  TempDir t;
  write_snapshot(t / "snap", snap(13, {{"greeting", "newer {{name}}"}, {"empty", ""}}).for_app("demo", "prod"));
  kyp::Client c(demo().snapshot_dir(t / "snap"));
  CHECK_EQ(c.revision(), 13);
  CHECK_EQ(c.status().source, "snapshot");
  CHECK_EQ(c.render("greeting", {{"name", "x"}}), "newer x");
}

TEST(embedded_blobs_seed_the_disk_cache) {
  TempDir t;
  { kyp::Client c(demo().cache_dir(t / "cache")); }
  CHECK(fs::exists(t / "cache" / "acme" / "demo" / "prod" / "envs" / "demo" / "prod.json"));
}

CHECK_MAIN
