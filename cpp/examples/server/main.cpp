// A simulated request loop: every request renders the current prompt, a deploy
// in the app swaps it in while the loop keeps running, and a health line
// reports where prompts come from and how fresh they are.
//
// Runs with zero files and zero network (an embedded snapshot is baked in), and
// picks up deploys when KYP_DELIVERY_KEY is set:
//   KYP_DELIVERY_KEY=kypd_... KYP_POLL_INTERVAL=5 ./kyp-example-server
#include <kyp/kyp.hpp>

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <iostream>
#include <thread>

namespace {
std::atomic<bool> g_stop{false};
}

int main(int argc, char** argv) {
  std::signal(SIGINT, [](int) { g_stop = true; });
  std::signal(SIGTERM, [](int) { g_stop = true; });
  int requests = argc > 1 ? std::atoi(argv[1]) : 40;  // 0 = run until Ctrl-C

  auto options = kyp::Options::from_env();
  if (!std::getenv("KYP_APP")) options.app("support-bot");
  options
      .on_update([](const kyp::Update& u) {
        std::cout << "[deploy] revision " << u.old_revision << " -> " << u.new_revision << " from " << u.source
                  << ", changed:";
        for (const auto& name : u.changed) std::cout << ' ' << name;
        std::cout << std::endl;
      })
      .logger([](kyp::LogLevel level, const std::string& msg) {
        if (level >= kyp::LogLevel::warn) std::cerr << "[kyp] " << msg << std::endl;
      });

  kyp::Client prompts(options);

  for (int i = 1; !g_stop && (requests == 0 || i <= requests); ++i) {
    // Per request: no I/O, no locks, just memory.
    kyp::Prompt p = prompts.prompt("triage");
    std::string text = p.render({{"company", "Acme"}, {"billing_queue", "refunds"}});
    std::cout << "request " << i << ": triage v" << p.version << ", " << text.size() << " chars: \""
              << text.substr(0, text.find('\n')) << "\"\n";

    if (i % 10 == 0) {
      kyp::Status s = prompts.status();
      std::cout << "[health] source=" << s.source << " revision=" << s.revision
                << " stale_for=" << std::chrono::duration_cast<std::chrono::seconds>(s.stale_for).count() << "s"
                << (s.last_error.empty() ? "" : " last_error=\"" + s.last_error + "\"") << std::endl;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
  }
  // ~Client stops the refresher and closes connections.
}
