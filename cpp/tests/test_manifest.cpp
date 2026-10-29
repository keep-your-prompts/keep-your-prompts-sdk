#include "../src/internal.hpp"
#include "check.hpp"

using kyp::detail::parse_manifest;

static const std::string kSha = std::string(64, 'a');

static std::string manifest(const std::string& body) {
  return "{\"schema\":1,\"workspace\":\"acme\",\"app\":\"support-bot\",\"env\":\"prod\"," + body;
}

TEST(parses_the_documented_example) {
  auto m = parse_manifest(manifest(R"("revision": 42, "deployed_at": "2026-10-29T14:03:11Z", "prompts": {
      "triage": {"sha256": ")" + kSha + R"(", "version": 7, "variables": ["company", "billing_queue"]},
      "agents/reviewer": {"sha256": ")" + std::string(64, 'b') + R"(", "version": 3, "variables": []}}})"),
                          "support-bot", "prod");
  CHECK_EQ(m.revision, 42);
  CHECK_EQ(m.workspace, "acme");
  CHECK_EQ(m.deployed_at, "2026-10-29T14:03:11Z");
  CHECK_EQ(m.prompts.size(), 2u);
  CHECK_EQ(m.prompts.at("triage").version, 7);
  CHECK_EQ(m.prompts.at("triage").variables.size(), 2u);
  CHECK_EQ(m.prompts.at("agents/reviewer").sha256, std::string(64, 'b'));
}
TEST(unknown_fields_are_ignored) {
  auto m = parse_manifest(manifest(R"("revision": 1, "new_top_level": {"x": [1,2]}, "signature": "abc",
      "prompts": {"p": {"sha256": ")" + kSha + R"(", "model": "claude", "tags": ["a"], "extra": {}}}})"),
                          "support-bot", "prod");
  CHECK_EQ(m.prompts.at("p").version, 0);
  CHECK(m.prompts.at("p").variables.empty());
}
TEST(uppercase_sha_is_normalised) {
  auto m = parse_manifest(manifest(R"("revision": 1, "prompts": {"p": {"sha256": ")" + std::string(64, 'A') + R"("}}})"),
                          "support-bot", "prod");
  CHECK_EQ(m.prompts.at("p").sha256, kSha);
}
TEST(rejects_invalid_manifests) {
  CHECK_THROWS_AS(parse_manifest("not json", "support-bot", "prod"), kyp::ProtocolError);
  CHECK_THROWS_AS(parse_manifest("[1,2]", "support-bot", "prod"), kyp::ProtocolError);
  CHECK_THROWS_AS(parse_manifest(manifest(R"("prompts": {}})"), "support-bot", "prod"), kyp::ProtocolError);
  CHECK_THROWS_AS(parse_manifest(manifest(R"("revision": "7", "prompts": {}})"), "support-bot", "prod"), kyp::ProtocolError);
  CHECK_THROWS_AS(parse_manifest(manifest(R"("revision": 1})"), "support-bot", "prod"), kyp::ProtocolError);
  CHECK_THROWS_AS(parse_manifest(manifest(R"("revision": 1, "prompts": {"p": {"sha256": "abc"}}})"), "support-bot", "prod"),
                  kyp::ProtocolError);
  CHECK_THROWS_AS(parse_manifest(manifest(R"("revision": 1, "prompts": {"p": {"sha256": "../../etc/passwd"}}})"),
                                 "support-bot", "prod"),
                  kyp::ProtocolError);
  CHECK_THROWS_AS(parse_manifest(manifest(R"("revision": 1, "prompts": {"p": {"version": 1}}})"), "support-bot", "prod"),
                  kyp::ProtocolError);
}
TEST(rejects_other_app_env_schema_or_workspace) {
  std::string ok = R"("revision": 1, "prompts": {}})";
  CHECK_THROWS_AS(parse_manifest(manifest(ok), "other-app", "prod"), kyp::ProtocolError);
  CHECK_THROWS_AS(parse_manifest(manifest(ok), "support-bot", "staging"), kyp::ProtocolError);
  CHECK_THROWS_AS(parse_manifest(R"({"schema":2,"workspace":"acme","app":"support-bot","env":"prod",)" + ok,
                                 "support-bot", "prod"),
                  kyp::ProtocolError);
  CHECK_THROWS_AS(parse_manifest(R"({"workspace":"../x","app":"support-bot","env":"prod",)" + ok, "support-bot", "prod"),
                  kyp::ProtocolError);
  // schema may be omitted
  CHECK_EQ(parse_manifest(R"({"workspace":"acme","app":"support-bot","env":"prod",)" + ok, "support-bot", "prod").revision, 1);
}
TEST(slugs) {
  CHECK(kyp::detail::is_slug("support-bot"));
  CHECK(kyp::detail::is_slug("a"));
  CHECK(!kyp::detail::is_slug("-a"));
  CHECK(!kyp::detail::is_slug("Prod"));
  CHECK(!kyp::detail::is_slug(""));
  CHECK(!kyp::detail::is_slug(std::string(64, 'a')));
}

CHECK_MAIN
