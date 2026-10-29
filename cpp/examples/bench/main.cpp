// Micro-benchmark: nanoseconds per get() and render() with N reader threads.
// Uses the embedded snapshot, so it needs no files and no network.
//
//   ./kyp-example-bench [seconds-per-case=1]
#include <kyp/kyp.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <thread>
#include <vector>

namespace {
using clk = std::chrono::steady_clock;

// Runs `op` on `threads` threads for `secs` seconds. Returns ns per call as seen
// by one thread (wall time / calls per thread) and total calls per second.
std::pair<double, double> run(int threads, double secs, const std::function<std::size_t()>& op) {
  std::atomic<bool> go{false}, done{false};
  std::atomic<std::size_t> sink{0};
  std::vector<std::uint64_t> calls(threads, 0);
  std::vector<double> elapsed(threads, 0);
  std::vector<std::thread> ts;
  for (int t = 0; t < threads; ++t)
    ts.emplace_back([&, t] {
      while (!go.load()) std::this_thread::yield();
      std::size_t local = 0;
      std::uint64_t n = 0;
      auto start = clk::now();
      while (!done.load(std::memory_order_relaxed)) {
        for (int i = 0; i < 256; ++i) local += op();
        n += 256;
      }
      elapsed[t] = std::chrono::duration<double, std::nano>(clk::now() - start).count();
      calls[t] = n;
      sink += local;
    });
  go = true;
  std::this_thread::sleep_for(std::chrono::duration<double>(secs));
  done = true;
  for (auto& th : ts) th.join();
  double ns = 0, total = 0;
  for (int t = 0; t < threads; ++t) {
    ns += elapsed[t] / static_cast<double>(calls[t]);
    total += static_cast<double>(calls[t]) / (elapsed[t] / 1e9);
  }
  if (sink.load() == 42) std::puts("");  // keep the work observable
  return {ns / threads, total};
}
}  // namespace

int main(int argc, char** argv) {
  double secs = argc > 1 ? std::atof(argv[1]) : 1.0;
  kyp::Client prompts(kyp::Options().app("support-bot").env("prod").log_level(kyp::LogLevel::error));
  const kyp::Vars vars{{"company", "Acme"}, {"billing_queue", "refunds"}};
  std::size_t len = prompts.get("triage").size();

  unsigned hw = std::max(1u, std::thread::hardware_concurrency());
  std::vector<int> thread_counts{1, 2, 4};
  if (hw > 4) thread_counts.push_back(static_cast<int>(hw));
  if (hw < 4) thread_counts.erase(std::remove_if(thread_counts.begin(), thread_counts.end(),
                                                 [&](int n) { return n > static_cast<int>(hw); }),
                                  thread_counts.end());

  std::printf("kyp %s micro-benchmark: prompt \"triage\" (%zu bytes, 2 variables), %u hardware threads\n\n",
              KYP_VERSION_STRING, len, hw);
  std::printf("%-26s %8s %12s %16s\n", "operation", "threads", "ns/call", "calls/s total");
  struct Case {
    const char* name;
    std::function<std::size_t()> op;
  };
  std::vector<Case> cases{
      {"contains(name)", [&] { return static_cast<std::size_t>(prompts.contains("triage")); }},
      {"get(name)", [&] { return prompts.get("triage").size(); }},
      {"render(name, 2 vars)", [&] { return prompts.render("triage", vars).size(); }},
      {"prompt(name)", [&] { return prompts.prompt("triage").text.size(); }},
  };
  for (const auto& c : cases)
    for (int n : thread_counts) {
      auto [ns, total] = run(n, secs, c.op);
      std::printf("%-26s %8d %12.1f %16.0f\n", c.name, n, ns, total);
    }
}
