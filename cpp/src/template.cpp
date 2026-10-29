// {{name}} rendering. No logic, loops or escaping: prompts are plain text.
#include "internal.hpp"

#include <algorithm>

namespace kyp {
namespace {

inline bool ident_start(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'; }
inline bool ident_char(char c) { return ident_start(c) || (c >= '0' && c <= '9'); }
inline bool space(char c) { return c == ' ' || c == '\t'; }

// At t[i] == "{{": parse "{{ name }}". On success returns the name and sets `end`
// to the index after "}}".
std::optional<std::string_view> parse_var(std::string_view t, std::size_t i, std::size_t& end) {
  std::size_t j = i + 2;
  while (j < t.size() && space(t[j])) ++j;
  if (j >= t.size() || !ident_start(t[j])) return std::nullopt;
  std::size_t start = j;
  while (j < t.size() && ident_char(t[j])) ++j;
  std::string_view name = t.substr(start, j - start);
  while (j < t.size() && space(t[j])) ++j;
  if (j + 1 >= t.size() || t[j] != '}' || t[j + 1] != '}') return std::nullopt;
  end = j + 2;
  return name;
}

// Walks the template, calling lit(text) and var(name, raw) in order.
template <class Lit, class Var>
void scan(std::string_view t, Lit&& lit, Var&& var) {
  std::size_t i = 0, run = 0;
  while (i < t.size()) {
    std::size_t open = t.find("{{", i);
    if (open == std::string_view::npos) break;
    if (t.compare(open, 4, "{{{{") == 0) {
      lit(t.substr(run, open - run));
      lit(std::string_view("{{"));
      i = run = open + 4;
      continue;
    }
    std::size_t end = 0;
    if (auto name = parse_var(t, open, end)) {
      lit(t.substr(run, open - run));
      var(*name, t.substr(open, end - open));
      i = run = end;
    } else {
      i = open + 2;  // not a variable: keep the braces as text
    }
  }
  lit(t.substr(run));
}

}  // namespace

std::string render(std::string_view tmpl, const Vars& vars, OnMissing on_missing) {
  std::string out;
  out.reserve(tmpl.size() + 64);
  std::vector<std::string> missing;
  std::string key;
  scan(
      tmpl, [&](std::string_view s) { out.append(s); },
      [&](std::string_view name, std::string_view raw) {
        key.assign(name);
        auto it = vars.find(key);
        if (it != vars.end()) {
          out.append(it->second);
        } else if (on_missing == OnMissing::keep) {
          out.append(raw);
        } else if (on_missing == OnMissing::error) {
          if (std::find(missing.begin(), missing.end(), key) == missing.end()) missing.push_back(key);
        }
      });
  if (!missing.empty()) throw MissingVariable(std::move(missing));
  return out;
}

std::vector<std::string> variables_in(std::string_view tmpl) {
  std::vector<std::string> names;
  scan(
      tmpl, [](std::string_view) {},
      [&](std::string_view name, std::string_view) {
        if (std::find(names.begin(), names.end(), name) == names.end()) names.emplace_back(name);
      });
  return names;
}

MissingVariable::MissingVariable(std::vector<std::string> names)
    : Error([&] {
        std::string m = names.size() == 1 ? "missing template variable: " : "missing template variables: ";
        for (std::size_t i = 0; i < names.size(); ++i) m += (i ? ", " : "") + names[i];
        return m;
      }()),
      names_(std::move(names)) {}

NotFound::NotFound(std::string name, const std::string& detail)
    : Error("prompt not found: \"" + name + "\"" + (detail.empty() ? "" : " (" + detail + ")")),
      name_(std::move(name)) {}

}  // namespace kyp
