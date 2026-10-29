// Prompt metadata and telemetry helpers (protocol/tracing.md).
#include <kyp/kyp.hpp>

#include <algorithm>
#include <cctype>

namespace kyp {

std::string to_string(const AttrValue& v) {
  if (const auto* s = std::get_if<std::string>(&v)) return *s;
  return std::to_string(std::get<std::int64_t>(v));
}

Attributes PromptMeta::attributes(bool gen_ai) const {
  Attributes a{
      {"kyp.prompt.name", name},     {"kyp.prompt.version", version}, {"kyp.prompt.sha256", sha256},
      {"kyp.app", app},              {"kyp.env", env},                {"kyp.revision", revision},
  };
  if (!workspace.empty()) a.emplace_back("kyp.workspace", workspace);
  if (!source.empty()) a.emplace_back("kyp.source", source);
  if (gen_ai) {
    a.emplace_back("gen_ai.prompt.name", name);
    a.emplace_back("gen_ai.prompt.version", std::to_string(version));
  }
  return a;
}

Attributes PromptMeta::trace_metadata() const {
  Attributes a = attributes(false);
  for (auto& kv : a) std::replace(kv.first.begin(), kv.first.end(), '.', '_');
  return a;
}

const char* to_string(RefreshTrigger t) {
  switch (t) {
    case RefreshTrigger::start: return "start";
    case RefreshTrigger::poll: return "poll";
    case RefreshTrigger::manual: return "manual";
  }
  return "poll";
}

const char* to_string(RefreshResult r) {
  switch (r) {
    case RefreshResult::updated: return "updated";
    case RefreshResult::not_modified: return "not_modified";
    case RefreshResult::failed: return "failed";
  }
  return "failed";
}

const AttrValue* TelemetryEvent::attr(std::string_view key) const {
  for (const auto& kv : attributes)
    if (kv.first == key) return &kv.second;
  return nullptr;
}

std::string normalize_source(std::string_view name, std::string_view kind) {
  if (name.empty()) return {};
  if (name == "disk-cache" || name == "cache") return "cache";
  for (std::string_view s : {"embedded", "snapshot", "cdn", "origin", "git"})
    if (name == s) return std::string(s);
  if (kind == "embedded") return "embedded";
  if (kind == "cache") return "cache";
  if (kind == "file") return "snapshot";
  return "custom";
}

std::string classify_error(std::string_view message) {
  std::string m(message);
  std::transform(m.begin(), m.end(), m.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  auto has = [&](std::string_view w) { return m.find(w) != std::string::npos; };
  // "http 503" / "HTTP 404": the status code after "http ".
  std::string status;
  if (auto i = m.find("http "); i != std::string::npos) {
    std::size_t j = i + 5;
    while (j < m.size() && std::isdigit(static_cast<unsigned char>(m[j]))) ++j;
    if (j - (i + 5) == 3) status = m.substr(i + 5, 3);
  }
  if (has("blob ") && has(" unavailable")) return "blob_unavailable";
  if (has("sha256 verification") || has("hash mismatch")) return "hash_mismatch";
  if (has("stale manifest")) return "stale";
  if (has("bad manifest") || has("invalid manifest")) return "bad_manifest";
  if (status == "404" || status == "410" || has("not found") || has("no such file") || has("not embedded"))
    return "not_found";
  if (!status.empty()) return "http_" + status;
  if (has("timed out") || has("timeout") || has("deadline")) return "timeout";
  for (std::string_view w : {"connect", "refused", "reset", "resolve", "unreachable", "network", "socket", "ssl", "tls"})
    if (has(w)) return "network";
  return "_OTHER";
}

}  // namespace kyp
