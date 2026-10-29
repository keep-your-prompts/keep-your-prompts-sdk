// kyp-snapshot: pull a snapshot folder for an app env.
//
//   kyp-snapshot --app support-bot --env prod --out ./prompts
//
// Reads KYP_DELIVERY_KEY (or --key). Writes envs/<app>/<env>.json and blobs/<sha256>,
// each verified, each written atomically. Commit the folder or bake it into the
// binary with kyp_embed_snapshot().
#include <kyp/kyp.hpp>

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>

namespace {
void usage(std::ostream& os) {
  os << "usage: kyp-snapshot --app <app> [--env prod] --out <dir> [options]\n"
        "\n"
        "options:\n"
        "  --key <kypd_...>      delivery key (default: $KYP_DELIVERY_KEY)\n"
        "  --cdn <url>           CDN base (default: https://cdn.keepyourprompts.com/v1/d)\n"
        "  --origin <url>        origin base (default: https://api.keepyourprompts.com/v1/delivery)\n"
        "  --git <url>           git mirror base, e.g. https://raw.githubusercontent.com/acme/prompts/main/.kyp\n"
        "  --git-token <token>   token for a private git mirror (default: $KYP_GIT_TOKEN)\n"
        "  --mirror <url>        use only these mirrors (repeatable; file:// or https://)\n"
        "  --timeout <seconds>   per-request timeout (default 5)\n"
        "  -q, --quiet           print nothing on success\n";
}
}  // namespace

int main(int argc, char** argv) {
  kyp::Options o;
  o.log_level(kyp::LogLevel::error);
  const char* key = std::getenv("KYP_DELIVERY_KEY");
  if (key) o.delivery_key(key);
  const char* git_token = std::getenv("KYP_GIT_TOKEN");
  std::string out, git;
  std::vector<kyp::Mirror> mirrors;
  bool quiet = false;

  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    auto next = [&]() -> std::string {
      if (i + 1 >= argc) {
        std::cerr << "kyp-snapshot: " << a << " needs a value\n";
        std::exit(2);
      }
      return argv[++i];
    };
    if (a == "--app") o.app(next());
    else if (a == "--env") o.env(next());
    else if (a == "--out") out = next();
    else if (a == "--key") o.delivery_key(next());
    else if (a == "--cdn") o.cdn_base(next());
    else if (a == "--origin") o.origin_base(next());
    else if (a == "--git") git = next();
    else if (a == "--git-token") { static std::string t; t = next(); git_token = t.c_str(); }
    else if (a == "--mirror") {
      std::string url = next();
      bool http = url.rfind("http://", 0) == 0 || url.rfind("https://", 0) == 0;
      std::string name = "mirror" + std::to_string(mirrors.size() + 1);
      mirrors.push_back(http ? kyp::Mirror::http(url, name) : kyp::Mirror::file(url, name));
    }
    else if (a == "--timeout") o.request_timeout(std::chrono::milliseconds(static_cast<long long>(std::atof(next().c_str()) * 1000)));
    else if (a == "-q" || a == "--quiet") quiet = true;
    else if (a == "-h" || a == "--help") { usage(std::cout); return 0; }
    else {
      std::cerr << "kyp-snapshot: unknown argument " << a << "\n\n";
      usage(std::cerr);
      return 2;
    }
  }
  if (out.empty()) {
    usage(std::cerr);
    return 2;
  }
  if (!git.empty()) o.git_mirror(git, git_token ? git_token : "");
  if (!mirrors.empty()) o.mirrors(mirrors);

  try {
    kyp::SnapshotInfo info = kyp::pull_snapshot(o, out);
    if (!quiet)
      std::cout << "Pulled " << info.workspace << " revision " << info.revision << " (" << info.prompt_count
                << (info.prompt_count == 1 ? " prompt" : " prompts") << ", " << info.blobs_written
                << " new blobs) from " << info.source << " into " << out << "\n";
    return 0;
  } catch (const std::exception& e) {
    std::cerr << "kyp-snapshot: " << e.what() << "\n";
    return 1;
  }
}
