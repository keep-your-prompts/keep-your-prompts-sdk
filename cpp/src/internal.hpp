// Internal pieces shared by the library, the tool and the tests. Not installed.
#pragma once

#include <kyp/kyp.hpp>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace kyp::detail {

// --- sha256 -----------------------------------------------------------------
class Sha256 {
 public:
  Sha256();
  void update(const void* data, std::size_t len);
  void finish(unsigned char out[32]);
  std::string hex();

 private:
  void block(const unsigned char* p);
  std::uint32_t h_[8];
  unsigned char buf_[64];
  std::size_t buf_len_ = 0;
  std::uint64_t total_ = 0;
};

// --- manifest ---------------------------------------------------------------
struct ManifestPrompt {
  std::string sha256;
  std::int64_t version = 0;
  std::vector<std::string> variables;
};

struct Manifest {
  int schema = 1;
  std::string workspace, app, env, deployed_at;
  std::int64_t revision = 0;
  std::map<std::string, ManifestPrompt> prompts;
};

// Throws kyp::ProtocolError. Unknown fields are ignored.
Manifest parse_manifest(std::string_view json, std::string_view app, std::string_view env);

bool is_slug(std::string_view s);         // [a-z0-9][a-z0-9-]{0,62}
bool is_sha256_hex(std::string_view s);   // 64 lowercase hex
bool is_workspace_slug(std::string_view s);

// --- fetching ---------------------------------------------------------------
struct FetchResult {
  enum Kind { ok, not_modified, not_found, failed } kind = failed;
  std::string body;
  std::string etag;
  std::string error;  // human readable, never contains the delivery key
};

enum class MirrorKind { embedded, file, cache, http };
MirrorKind mirror_kind(std::string_view url);
std::filesystem::path file_url_to_path(std::string_view url);

FetchResult read_file(const std::filesystem::path& path);
FetchResult read_embedded(std::string_view rel_path);
bool has_embedded(std::string_view rel_path);

struct HttpSettings {
  std::chrono::milliseconds connect_timeout{2000};
  std::chrono::milliseconds request_timeout{5000};
  std::string user_agent;
};

// One reusable connection (libcurl easy handle). Not thread-safe; the client
// uses it from one thread at a time.
class HttpClient {
 public:
  explicit HttpClient(HttpSettings s);
  ~HttpClient();
  HttpClient(const HttpClient&) = delete;
  HttpClient& operator=(const HttpClient&) = delete;
  FetchResult get(const std::string& url, const std::string& if_none_match,
                  const std::string& bearer, std::chrono::steady_clock::time_point deadline,
                  const std::atomic<bool>* cancel);
  static bool available();

 private:
  HttpSettings s_;
  void* curl_ = nullptr;
};

// Write temp file + fsync + rename. Throws std::runtime_error.
void atomic_write(const std::filesystem::path& path, std::string_view data);

std::string redact(std::string text, const std::string& key);

}  // namespace kyp::detail
