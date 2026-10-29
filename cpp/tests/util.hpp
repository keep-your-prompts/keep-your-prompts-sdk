// Test helpers: temp dirs and snapshot folders in the protocol layout.
#pragma once

#include <kyp/kyp.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <map>
#include <random>
#include <set>
#include <string>
#include <thread>

namespace fs = std::filesystem;

struct TempDir {
  fs::path path;
  TempDir() {
    std::random_device rd;
    path = fs::temp_directory_path() / ("kyp-test-" + std::to_string(rd()) + std::to_string(rd()));
    fs::create_directories(path);
  }
  ~TempDir() {
    std::error_code ec;
    fs::remove_all(path, ec);
  }
  fs::path operator/(const std::string& s) const { return path / s; }
};

inline void write_file(const fs::path& p, const std::string& data) {
  fs::create_directories(p.parent_path());
  std::ofstream out(p, std::ios::binary | std::ios::trunc);
  out << data;
}

inline std::string read_file(const fs::path& p) {
  std::ifstream in(p, std::ios::binary);
  return std::string(std::istreambuf_iterator<char>(in), {});
}

struct SnapshotSpec {
  std::string workspace = "acme";
  std::string app = "support-bot";
  std::string env = "prod";
  std::int64_t revision = 1;
  std::map<std::string, std::string> prompts;  // name -> text
  std::set<std::string> corrupt;               // names whose blob is tampered with
  std::string extra = R"("future_field": {"nested": [1, 2, 3]},)";

  SnapshotSpec& corrupting(std::string name) { corrupt.insert(std::move(name)); return *this; }
  SnapshotSpec& for_app(std::string a, std::string e) { app = std::move(a); env = std::move(e); return *this; }
};

inline SnapshotSpec snap(std::int64_t revision, std::map<std::string, std::string> prompts) {
  SnapshotSpec s;
  s.revision = revision;
  s.prompts = std::move(prompts);
  return s;
}

// Writes envs/<app>/<env>.json and blobs/<sha> under dir. Returns name -> sha.
inline std::map<std::string, std::string> write_snapshot(const fs::path& dir, const SnapshotSpec& s) {
  std::map<std::string, std::string> shas;
  std::string prompts;
  for (const auto& [name, text] : s.prompts) {
    std::string sha = kyp::sha256_hex(text);
    shas[name] = sha;
    write_file(dir / "blobs" / sha, s.corrupt.count(name) ? text + " (tampered)" : text);
    if (!prompts.empty()) prompts += ",\n";
    prompts += "    \"" + name + "\": {\"sha256\": \"" + sha + "\", \"version\": " + std::to_string(s.revision) +
               ", \"labels\": [\"x\"]}";
  }
  write_file(dir / "envs" / s.app / (s.env + ".json"),
             "{\n  \"schema\": 1,\n  " + s.extra + "\n  \"workspace\": \"" + s.workspace + "\",\n  \"app\": \"" +
                 s.app + "\",\n  \"env\": \"" + s.env + "\",\n  \"revision\": " + std::to_string(s.revision) +
                 ",\n  \"deployed_at\": \"2026-10-29T14:03:11Z\",\n  \"prompts\": {\n" + prompts + "\n  }\n}\n");
  return shas;
}

inline kyp::Options quiet_options() {
  return kyp::Options()
      .app("support-bot")
      .env("prod")
      .embedded_snapshot(false)
      .logger([](kyp::LogLevel, const std::string&) {});
}

template <class F>
bool eventually(F&& pred, std::chrono::milliseconds timeout = std::chrono::milliseconds(5000)) {
  auto end = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < end) {
    if (pred()) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  return pred();
}
