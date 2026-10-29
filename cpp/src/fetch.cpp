// Mirror transports: files, embedded data and HTTP(S) via libcurl.
#include "internal.hpp"

#include <cctype>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <mutex>
#include <random>
#include <sstream>
#include <thread>

#if defined(__unix__) || defined(__APPLE__)
#include <fcntl.h>
#include <unistd.h>
#define KYP_POSIX 1
#endif

#ifdef KYP_WITH_CURL
#include <curl/curl.h>
#endif

namespace fs = std::filesystem;

namespace kyp::detail {

MirrorKind mirror_kind(std::string_view url) {
  if (url == "embedded:" || url == "embedded") return MirrorKind::embedded;
  if (url.rfind("http://", 0) == 0 || url.rfind("https://", 0) == 0) return MirrorKind::http;
  return MirrorKind::file;
}

fs::path file_url_to_path(std::string_view url) {
  if (url.rfind("file://", 0) == 0) url.remove_prefix(7);
  return fs::path(std::string(url));
}

FetchResult read_file(const fs::path& path) {
  FetchResult r;
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    std::error_code ec;
    r.kind = fs::exists(path, ec) ? FetchResult::failed : FetchResult::not_found;
    r.error = (r.kind == FetchResult::not_found ? "no such file: " : "cannot read: ") + path.string();
    return r;
  }
  std::ostringstream ss;
  ss << in.rdbuf();
  if (in.bad()) {
    r.error = "read failed: " + path.string();
    return r;
  }
  r.kind = FetchResult::ok;
  r.body = std::move(ss).str();
  return r;
}

void atomic_write(const fs::path& path, std::string_view data) {
  fs::create_directories(path.parent_path());
  static std::atomic<unsigned> counter{0};
  thread_local std::mt19937_64 rng(std::random_device{}() ^
                                   std::hash<std::thread::id>{}(std::this_thread::get_id()));
  fs::path tmp = path;
  tmp += ".tmp-" + std::to_string(rng()) + "-" + std::to_string(counter++);
#ifdef KYP_POSIX
  int fd = ::open(tmp.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
  if (fd < 0) throw std::runtime_error("cannot create " + tmp.string() + ": " + std::strerror(errno));
  const char* p = data.data();
  std::size_t left = data.size();
  while (left > 0) {
    ssize_t n = ::write(fd, p, left);
    if (n < 0) {
      if (errno == EINTR) continue;
      int e = errno;
      ::close(fd);
      ::unlink(tmp.c_str());
      throw std::runtime_error("cannot write " + tmp.string() + ": " + std::strerror(e));
    }
    p += n;
    left -= static_cast<std::size_t>(n);
  }
  ::fsync(fd);
  ::close(fd);
#else
  {
    std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
    out.write(data.data(), static_cast<std::streamsize>(data.size()));
    out.flush();
    if (!out) {
      std::error_code ec;
      fs::remove(tmp, ec);
      throw std::runtime_error("cannot write " + tmp.string());
    }
  }
#endif
  std::error_code ec;
  fs::rename(tmp, path, ec);
  if (ec) {
    std::error_code ignored;
    fs::remove(tmp, ignored);
    throw std::runtime_error("cannot rename into " + path.string() + ": " + ec.message());
  }
}

std::string redact(std::string text, const std::string& key) {
  if (key.size() < 8) return text;
  std::string shown = key.substr(0, 9) + "...";
  for (std::size_t pos = text.find(key); pos != std::string::npos; pos = text.find(key, pos + shown.size()))
    text.replace(pos, key.size(), shown);
  return text;
}

// --- HTTP -------------------------------------------------------------------
#ifdef KYP_WITH_CURL
namespace {
constexpr std::size_t kMaxBody = 16u << 20;  // 16 MiB: far above any manifest or prompt

void global_init() {
  static std::once_flag once;
  std::call_once(once, [] { curl_global_init(CURL_GLOBAL_DEFAULT); });
}

struct Transfer {
  std::string body;
  std::string etag;
  bool too_big = false;
  const std::atomic<bool>* cancel = nullptr;
};

size_t on_body(char* p, size_t size, size_t n, void* ud) {
  auto* t = static_cast<Transfer*>(ud);
  size_t len = size * n;
  if (t->body.size() + len > kMaxBody) {
    t->too_big = true;
    return 0;
  }
  t->body.append(p, len);
  return len;
}

size_t on_header(char* p, size_t size, size_t n, void* ud) {
  auto* t = static_cast<Transfer*>(ud);
  size_t len = size * n;
  std::string_view line(p, len);
  if (line.size() > 5) {
    std::string lower(line.substr(0, 5));
    for (auto& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (lower == "etag:") {
      std::string_view v = line.substr(5);
      while (!v.empty() && (v.front() == ' ' || v.front() == '\t')) v.remove_prefix(1);
      while (!v.empty() && (v.back() == '\r' || v.back() == '\n' || v.back() == ' ')) v.remove_suffix(1);
      t->etag.assign(v);
    }
  }
  return len;
}

int on_progress(void* ud, curl_off_t, curl_off_t, curl_off_t, curl_off_t) {
  auto* t = static_cast<Transfer*>(ud);
  return (t->cancel && t->cancel->load(std::memory_order_relaxed)) ? 1 : 0;
}
}  // namespace

HttpClient::HttpClient(HttpSettings s) : s_(std::move(s)) {
  global_init();
  curl_ = curl_easy_init();
}

HttpClient::~HttpClient() {
  if (curl_) curl_easy_cleanup(static_cast<CURL*>(curl_));
}

bool HttpClient::available() { return true; }

FetchResult HttpClient::get(const std::string& url, const std::string& if_none_match, const std::string& bearer,
                            std::chrono::steady_clock::time_point deadline, const std::atomic<bool>* cancel) {
  FetchResult r;
  CURL* c = static_cast<CURL*>(curl_);
  if (!c) {
    r.error = "libcurl initialisation failed";
    return r;
  }
  using namespace std::chrono;
  auto total = s_.request_timeout;
  if (deadline != steady_clock::time_point::max()) {
    auto left = duration_cast<milliseconds>(deadline - steady_clock::now());
    if (left <= milliseconds(0)) {
      r.error = "deadline exceeded";
      return r;
    }
    total = std::min(total, left);
  }

  Transfer t;
  t.cancel = cancel;
  curl_easy_reset(c);  // keeps the connection cache: connections are reused
  curl_easy_setopt(c, CURLOPT_URL, url.c_str());
  curl_easy_setopt(c, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 1L);
  curl_easy_setopt(c, CURLOPT_MAXREDIRS, 3L);
#if LIBCURL_VERSION_NUM >= 0x075500
  curl_easy_setopt(c, CURLOPT_PROTOCOLS_STR, "http,https");
  curl_easy_setopt(c, CURLOPT_REDIR_PROTOCOLS_STR, "http,https");
#endif
  curl_easy_setopt(c, CURLOPT_HTTP_VERSION, static_cast<long>(CURL_HTTP_VERSION_2TLS));
  curl_easy_setopt(c, CURLOPT_ACCEPT_ENCODING, "");
  curl_easy_setopt(c, CURLOPT_TCP_KEEPALIVE, 1L);
  curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT_MS, static_cast<long>(s_.connect_timeout.count()));
  curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, static_cast<long>(total.count()));
  curl_easy_setopt(c, CURLOPT_USERAGENT, s_.user_agent.c_str());
  curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, on_body);
  curl_easy_setopt(c, CURLOPT_WRITEDATA, &t);
  curl_easy_setopt(c, CURLOPT_HEADERFUNCTION, on_header);
  curl_easy_setopt(c, CURLOPT_HEADERDATA, &t);
  curl_easy_setopt(c, CURLOPT_NOPROGRESS, 0L);
  curl_easy_setopt(c, CURLOPT_XFERINFOFUNCTION, on_progress);
  curl_easy_setopt(c, CURLOPT_XFERINFODATA, &t);

  struct curl_slist* headers = nullptr;
  std::string inm, auth;
  if (!if_none_match.empty()) {
    inm = "If-None-Match: " + if_none_match;
    headers = curl_slist_append(headers, inm.c_str());
  }
  if (!bearer.empty()) {
    auth = "Authorization: Bearer " + bearer;
    headers = curl_slist_append(headers, auth.c_str());
  }
  if (headers) curl_easy_setopt(c, CURLOPT_HTTPHEADER, headers);

  CURLcode rc = curl_easy_perform(c);
  long status = 0;
  curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &status);
  if (headers) curl_slist_free_all(headers);

  if (rc != CURLE_OK) {
    if (t.too_big)
      r.error = "response larger than 16 MiB";
    else if (rc == CURLE_ABORTED_BY_CALLBACK)
      r.error = "cancelled";
    else
      r.error = curl_easy_strerror(rc);
    return r;
  }
  if (status == 304) {
    r.kind = FetchResult::not_modified;
    r.etag = if_none_match;
  } else if (status >= 200 && status < 300) {
    r.kind = FetchResult::ok;
    r.body = std::move(t.body);
    r.etag = std::move(t.etag);
  } else if (status == 404 || status == 410) {
    r.kind = FetchResult::not_found;
    r.error = "HTTP " + std::to_string(status);
  } else {
    r.error = "HTTP " + std::to_string(status);
  }
  return r;
}
#else
HttpClient::HttpClient(HttpSettings s) : s_(std::move(s)) {}
HttpClient::~HttpClient() = default;
bool HttpClient::available() { return false; }
FetchResult HttpClient::get(const std::string&, const std::string&, const std::string&,
                            std::chrono::steady_clock::time_point, const std::atomic<bool>*) {
  FetchResult r;
  r.error = "HTTP mirrors need libcurl (this build has KYP_WITH_CURL=OFF)";
  return r;
}
#endif

}  // namespace kyp::detail
