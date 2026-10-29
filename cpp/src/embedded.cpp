// Registry for snapshots baked in with kyp_embed_snapshot().
#include "internal.hpp"

#include <mutex>
#include <unordered_map>

namespace kyp::detail {
namespace {
struct Registry {
  std::mutex mu;
  std::unordered_map<std::string, std::string_view> files;
};
Registry& registry() {
  static Registry r;  // function-local: safe during static initialisation
  return r;
}
}  // namespace

void register_embedded_files(const char* const* paths, const unsigned char* const* data,
                             const std::size_t* sizes, std::size_t count) noexcept {
  try {
    Registry& r = registry();
    std::lock_guard<std::mutex> lock(r.mu);
    for (std::size_t i = 0; i < count; ++i)
      r.files[paths[i]] = std::string_view(reinterpret_cast<const char*>(data[i]), sizes[i]);
  } catch (...) {
    // Out of memory during static init: the embedded mirror simply stays empty.
  }
}

FetchResult read_embedded(std::string_view rel) {
  Registry& r = registry();
  std::lock_guard<std::mutex> lock(r.mu);
  auto it = r.files.find(std::string(rel));
  FetchResult res;
  if (it == r.files.end()) {
    res.kind = FetchResult::not_found;
    res.error = "not embedded: " + std::string(rel);
  } else {
    res.kind = FetchResult::ok;
    res.body.assign(it->second);
  }
  return res;
}

bool has_embedded(std::string_view rel) {
  Registry& r = registry();
  std::lock_guard<std::mutex> lock(r.mu);
  return r.files.count(std::string(rel)) > 0;
}

}  // namespace kyp::detail
