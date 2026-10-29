// Manifest parsing: envs/<app>/<env>.json
#include "internal.hpp"

#include <nlohmann/json.hpp>

namespace kyp::detail {

bool is_slug(std::string_view s) {
  if (s.empty() || s.size() > 63) return false;
  auto ok = [](char c, bool first) {
    return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || (!first && c == '-');
  };
  for (std::size_t i = 0; i < s.size(); ++i)
    if (!ok(s[i], i == 0)) return false;
  return true;
}

bool is_workspace_slug(std::string_view s) {
  if (s.empty() || s.size() > 128 || s == "." || s == "..") return false;
  for (char c : s) {
    bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' ||
              c == '_' || c == '.';
    if (!ok) return false;
  }
  return true;
}

bool is_sha256_hex(std::string_view s) {
  if (s.size() != 64) return false;
  for (char c : s)
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  return true;
}

Manifest parse_manifest(std::string_view text, std::string_view app, std::string_view env) {
  using nlohmann::json;
  json j = json::parse(text.begin(), text.end(), nullptr, /*allow_exceptions=*/false);
  if (j.is_discarded() || !j.is_object()) throw ProtocolError("manifest is not a JSON object");

  Manifest m;
  if (j.contains("schema")) {
    if (!j["schema"].is_number_integer() || j["schema"].get<int>() != 1)
      throw ProtocolError("unsupported manifest schema (this SDK reads schema 1)");
  }
  auto str = [&](const char* k, bool required) -> std::string {
    auto it = j.find(k);
    if (it == j.end() || it->is_null()) {
      if (required) throw ProtocolError(std::string("manifest is missing \"") + k + "\"");
      return {};
    }
    if (!it->is_string()) throw ProtocolError(std::string("manifest \"") + k + "\" must be a string");
    return it->get<std::string>();
  };
  m.workspace = str("workspace", true);
  m.app = str("app", true);
  m.env = str("env", true);
  m.deployed_at = str("deployed_at", false);
  if (!is_workspace_slug(m.workspace)) throw ProtocolError("manifest workspace is not a valid slug");
  if (m.app != app || m.env != env)
    throw ProtocolError("manifest is for " + m.app + "/" + m.env + ", expected " + std::string(app) + "/" +
                        std::string(env));

  auto rev = j.find("revision");
  if (rev == j.end() || !rev->is_number_integer() || rev->get<std::int64_t>() < 0)
    throw ProtocolError("manifest \"revision\" must be a non-negative integer");
  m.revision = rev->get<std::int64_t>();

  auto prompts = j.find("prompts");
  if (prompts == j.end() || !prompts->is_object()) throw ProtocolError("manifest \"prompts\" must be an object");
  for (auto it = prompts->begin(); it != prompts->end(); ++it) {
    const std::string& name = it.key();
    const json& p = it.value();
    if (name.empty() || name.front() == '/' || name.back() == '/' || name.find("//") != std::string::npos)
      throw ProtocolError("invalid prompt name \"" + name + "\"");
    if (!p.is_object()) throw ProtocolError("prompt \"" + name + "\" must be an object");
    ManifestPrompt mp;
    auto sha = p.find("sha256");
    if (sha == p.end() || !sha->is_string()) throw ProtocolError("prompt \"" + name + "\" has no sha256");
    mp.sha256 = sha->get<std::string>();
    for (auto& c : mp.sha256)
      if (c >= 'A' && c <= 'F') c = static_cast<char>(c - 'A' + 'a');
    if (!is_sha256_hex(mp.sha256)) throw ProtocolError("prompt \"" + name + "\" has an invalid sha256");
    auto ver = p.find("version");
    if (ver != p.end() && ver->is_number_integer()) mp.version = ver->get<std::int64_t>();
    auto vars = p.find("variables");
    if (vars != p.end() && vars->is_array())
      for (const auto& v : *vars)
        if (v.is_string()) mp.variables.push_back(v.get<std::string>());
    m.prompts.emplace(name, std::move(mp));
  }
  return m;
}

}  // namespace kyp::detail
