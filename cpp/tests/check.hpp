// A tiny test harness: TEST, CHECK, CHECK_EQ, CHECK_THROWS_AS. No dependencies.
#pragma once

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <sstream>
#include <string>
#include <vector>

namespace check {
struct Failure {
  std::string msg;
};
struct Test {
  const char* name;
  void (*fn)();
};
inline std::vector<Test>& registry() {
  static std::vector<Test> r;
  return r;
}
struct Reg {
  Reg(const char* n, void (*f)()) { registry().push_back({n, f}); }
};
// Returns 0 if all pass. CHECK_FILTER=substring runs a subset.
inline int run() {
  const char* filter = std::getenv("CHECK_FILTER");
  int failed = 0, passed = 0;
  for (const Test& t : registry()) {
    if (filter && !std::strstr(t.name, filter)) continue;
    auto start = std::chrono::steady_clock::now();
    try {
      t.fn();
      ++passed;
      auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start);
      std::printf("  ok    %s (%lld ms)\n", t.name, static_cast<long long>(ms.count()));
    } catch (const Failure& f) {
      ++failed;
      std::printf("  FAIL  %s\n        %s\n", t.name, f.msg.c_str());
    } catch (const std::exception& e) {
      ++failed;
      std::printf("  FAIL  %s\n        unexpected exception: %s\n", t.name, e.what());
    }
    std::fflush(stdout);
  }
  std::printf("%d passed, %d failed\n", passed, failed);
  return failed ? 1 : 0;
}
}  // namespace check

#define TEST(name)                                         \
  static void name();                                      \
  static const ::check::Reg name##_registration(#name, name); \
  static void name()

#define CHECK_FAIL_(msg) throw ::check::Failure{std::string(__FILE__) + ":" + std::to_string(__LINE__) + ": " + (msg)}

#define CHECK(cond)                              \
  do {                                           \
    if (!(cond)) CHECK_FAIL_("CHECK(" #cond ")"); \
  } while (0)

#define CHECK_EQ(a, b)                                                       \
  do {                                                                       \
    const auto check_a_ = (a);                                              \
    const auto check_b_ = (b);                                              \
    if (!(check_a_ == check_b_)) {                                           \
      std::ostringstream check_os_;                                          \
      check_os_ << "CHECK_EQ(" #a ", " #b "): [" << check_a_ << "] != [" << check_b_ << "]"; \
      CHECK_FAIL_(check_os_.str());                                          \
    }                                                                        \
  } while (0)

#define CHECK_THROWS_AS(expr, T)                         \
  do {                                                   \
    bool check_thrown_ = false;                          \
    try {                                                \
      (void)(expr);                                      \
    } catch (const T&) {                                 \
      check_thrown_ = true;                              \
    } catch (...) {                                      \
    }                                                    \
    if (!check_thrown_) CHECK_FAIL_(#expr " did not throw " #T); \
  } while (0)

#define CHECK_MAIN \
  int main() { return ::check::run(); }
