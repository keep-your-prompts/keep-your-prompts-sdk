# Keep Your Prompts: Ruby SDK

Read deployed prompts from memory, keep them fresh in the background, and keep serving when the network does not.

```ruby
require "keepyourprompts"

prompts = KeepYourPrompts::Client.from_env # KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
system = prompts.render("triage", company: "Acme", billing_queue: "refunds")
```

- Gem `keepyourprompts`, version 0.1.0. Ruby 3.1 or newer.
- No runtime dependencies: Net::HTTP, Digest::SHA256 and JSON from the standard library.
- Implements [prompt delivery protocol v1](../protocol/README.md) and passes every required behaviour of the [conformance suite](../conformance/README.md).
- Fork-safe (Puma, Unicorn, Pitchfork); a tiny Rails railtie is included.
- This code is under the repository's [LICENSE](../LICENSE).

## Install

```ruby
# Gemfile
gem "keepyourprompts", "~> 0.1"
```

## Quickstart

```ruby
require "keepyourprompts"

# Set KYP_DELIVERY_KEY (kypd_...), KYP_APP=support-bot and optionally KYP_ENV=prod.
prompts = KeepYourPrompts::Client.from_env

prompts.get("triage")                                  # the raw template
prompts.render("triage", company: "Acme")              # keyword arguments...
prompts.render("triage", { "company" => "Acme" })      # ...or a hash; raises MissingVariable if one is missing
prompts.render("triage", on_missing: :keep)            # leaves {{company}} in place (:empty drops it)
p = prompts.prompt("triage")                           # Prompt: name, version, sha256, variables, text, #render
prompts.try_get("maybe")                               # nil when absent
puts prompts.status.to_h                               # which mirror served it, how stale it is

prompts.on_update do |u|
  Rails.logger.info("prompts #{u.old_revision} -> #{u.new_revision}: #{u.changed.join(", ")}")
end
```

`get`, `render` and `prompt` read memory only: no I/O and no locks. The state is a frozen object that the refresher replaces with a single assignment, so any number of threads (Puma, Sidekiq) can read while it swaps. `on_missing` is a reserved keyword of `render`; pass a variable with that name in the hash.

## With the Anthropic SDK

```ruby
require "anthropic" # gem "anthropic"
require "keepyourprompts"

prompts = KeepYourPrompts::Client.from_env
client = Anthropic::Client.new # reads ANTHROPIC_API_KEY

message = client.messages.create(
  model: :"claude-opus-5-5",
  max_tokens: 16_000,
  system_: [{ type: "text", text: prompts.render("triage", company: "Acme") }],
  messages: [{ role: "user", content: "My invoice is wrong." }]
)
message.content.each { |block| puts block.text if block.type == :text }
```

(`system_:` has a trailing underscore in the Anthropic gem so it does not shadow `Kernel#system`.)

## With the OpenAI SDK

```ruby
require "openai" # gem "openai"
require "keepyourprompts"

prompts = KeepYourPrompts::Client.from_env
client = OpenAI::Client.new # reads OPENAI_API_KEY

response = client.responses.create(
  model: "gpt-5",
  instructions: prompts.render("triage", company: "Acme"),
  input: "My invoice is wrong."
)
```

## Rails

The railtie loads with the gem. Configure with `ENV` (`KYP_APP`, `KYP_DELIVERY_KEY`, ...), and/or `config/keepyourprompts.yml`:

```yaml
# config/keepyourprompts.yml (per environment, ERB allowed)
production:
  app: support-bot
  env: prod
  delivery_key: <%= ENV["KYP_DELIVERY_KEY"] %>
  snapshot_dir: <%= Rails.root.join("prompts") %>
development:
  app: support-bot
  env: dev
  delivery_key: <%= ENV["KYP_DELIVERY_KEY"] %>
```

or `config.keepyourprompts.poll_interval = 10` in an environment file. Then anywhere:

```ruby
KeepYourPrompts.render("triage", company: current_account.name)
KeepYourPrompts.client.status.to_h # e.g. in a health check controller
```

`KeepYourPrompts.client` is built on first use (so under Puma and Unicorn it is created in each worker after forking), logs through `Rails.logger`, and caches to `tmp/cache/keepyourprompts` unless `KYP_CACHE_DIR` is set.

## Sinatra, Rack, Sidekiq and scripts

```ruby
require "keepyourprompts"
KeepYourPrompts.configure(app: "support-bot", snapshot_dir: "prompts") # optional; ENV is read otherwise

get "/answer" do
  KeepYourPrompts.render("triage", company: "Acme")
end
```

Or hold your own client: `PROMPTS = KeepYourPrompts::Client.from_env` at boot.

## Forking servers

A thread does not survive `fork`. The gem hooks `Process._fork` (Ruby 3.1+), which every fork goes through (`fork`, `Process.fork`, Puma cluster mode with `preload_app!`, Unicorn, Pitchfork), and in the child restarts each client's poller with fresh mutexes and drops the parent's HTTP connections without closing them. `status` and `refresh` also compare `Process.pid` and recover if something forked around the hook. Reads keep working in the child immediately (the state is inherited), so `preload_app!` with a client created at boot is fine.

## Configuration

| Keyword (`Client.new` / `Config.new` / `configure`) | Default | Environment (`from_env`) |
| --- | --- | --- |
| `app` | required | `KYP_APP` |
| `env` | `"prod"` | `KYP_ENV` |
| `delivery_key` | none: no CDN/origin | `KYP_DELIVERY_KEY` |
| `snapshot_dir` | none | `KYP_SNAPSHOT_DIR` |
| `cache_dir` | none: no disk cache | `KYP_CACHE_DIR` |
| `git_mirror`, `git_token` | none | `KYP_GIT_MIRROR`, `KYP_GIT_TOKEN` |
| `workspace` | found by scanning `cache_dir` | `KYP_WORKSPACE` |
| `cdn_url`, `origin_url` | `https://cdn.keepyourprompts.com/v1/d`, `https://api.keepyourprompts.com/v1/delivery` | `KYP_CDN_URL`, `KYP_ORIGIN_URL` |
| `mirrors` | snapshot, CDN, origin, git | |
| `poll_interval` | 30 s (plus or minus 10%) | `KYP_POLL_INTERVAL` (seconds) |
| `poller` | `true`; `false` means no thread, call `refresh` yourself | |
| `connect_timeout`, `request_timeout` | 2 s, 5 s | |
| `startup_timeout` | 3 s | |
| `start_empty` | `false` | |
| `max_backoff` | 300 s | |
| `user_agent` | `kyp-ruby/0.1.0` | |
| `logger` | `$stderr`; anything with `#debug/#info/#warn/#error` | |
| `log_level` | `:warn` | `KYP_LOG=debug\|info\|warn\|error\|off` |

`mirrors` replaces the defaults with your own ordered list of `KeepYourPrompts::Mirror.file(dir, name:)` and `KeepYourPrompts::Mirror.http(base_url, name:, token:)`; the disk cache still applies. To send the delivery key as a header to the origin instead of in the path: `Mirror.http("https://api.keepyourprompts.com/v1/delivery", name: "origin", token: key)`. The delivery key never appears in logs, errors, `status` or `inspect` (shortened to `kypd_Ab3d...`). HTTPS goes through `https_proxy`/`no_proxy` when set.

## Availability: mirrors

Every copy of your prompts uses the same layout (`envs/<app>/<env>.json`, `blobs/<sha256>`), so the client treats them as interchangeable mirrors:

| # | Mirror | Name in `status` | Enabled when |
| --- | --- | --- | --- |
| 1 | Snapshot folder | `snapshot` | `snapshot_dir` / `KYP_SNAPSHOT_DIR` |
| 2 | Disk cache written by the SDK | `disk-cache` | `cache_dir` / `KYP_CACHE_DIR` |
| 3 | CDN `https://cdn.keepyourprompts.com/v1/d/<key>` | `cdn` | a delivery key is set |
| 4 | Origin `https://api.keepyourprompts.com/v1/delivery/<key>` | `origin` | a delivery key is set |
| 5 | Your git repo (`.kyp/` written by the sync) | `git` | `git_mirror` / `KYP_GIT_MIRROR` (+ `KYP_GIT_TOKEN`, sent as `Authorization: Bearer`) |

**Start-up.** Mirrors 1 and 2 are read without the network; if either holds the manifest the constructor returns at once with the highest revision and the poller revalidates immediately. Otherwise it blocks on the network mirrors for up to `startup_timeout`, then raises `KeepYourPrompts::Unavailable` (or starts empty with `start_empty: true` and keeps trying).

**Refresh.** Every `poll_interval` the poller asks mirrors 3 to 5 in order with `If-None-Match` and stops at the first that answers (`304` costs nothing). A new revision has its missing blobs fetched (disk cache, then the same mirror, then any other), each verified with SHA-256, written to the disk cache, and then swapped in. A lower revision is ignored; a manifest for another app/env or schema is rejected. A failing mirror is skipped for 0, 1, 3, 7, ... poll intervals (capped at `max_backoff`) and retried first if nothing else answers. **Failures never evict**: with every mirror down, reads keep returning the last good prompts and `status.stale_for` grows. With no network mirror configured the snapshot folder itself is polled. The disk cache layout (`<cache_dir>/<workspace>/<app>/<env>/`) is shared with the other SDKs.

## Snapshots

`kyp pull --app support-bot --env prod --out ./prompts` writes a complete mirror to a folder. Commit it or bake it into the image and set `KYP_SNAPSHOT_DIR=./prompts` (or `snapshot_dir:` in the yml): the app boots with zero network and upgrades in the background as soon as a network mirror answers.

## API

| `KeepYourPrompts::Client` | |
| --- | --- |
| `new(config = nil, **options)`, `.from_env(env = ENV, **overrides)` | Loads prompts (start-up above). Raises `Unavailable`, or `KeepYourPrompts::Error` for invalid options. |
| `get(name)` | Raw template. Raises `NotFound` (`#name`). |
| `try_get(name)`, `include?(name)` | |
| `prompt(name)` | `Prompt` struct: `name`, `version`, `sha256`, `variables`, `text`, `render(**vars)`. |
| `render(name, vars = nil, on_missing: :error, **vars)` | Raises `NotFound` or `MissingVariable` (`#names`). |
| `names`, `revision` | |
| `on_update { \|update\| }` | `Update`: `old_revision`, `new_revision`, `source`, `changed`. Runs on the poller thread (or the caller of `refresh`); exceptions are logged. |
| `refresh` | Revalidate now, ignoring backoff. `true` if a mirror answered. |
| `status` | `ready?`, `source`, `revision`, `workspace`, `deployed_at`, `prompt_count`, `last_success`, `last_error`, `stale_for` (seconds), `mirrors` (`name`, `url`, `consecutive_failures`, `last_error`, `last_success`); `to_h`. |
| `close` | Stop the poller. Reads keep working. |

`KeepYourPrompts::Template.render(text, vars, on_missing:)` and `.variables(text)` are the pure template functions; `KeepYourPrompts::Manifest.parse(json, app:, env:)` validates a manifest. All errors inherit from `KeepYourPrompts::Error`: `NotFound`, `MissingVariable`, `Unavailable`, `ProtocolError`.

## Development

```sh
bundle install
bundle exec rake   # Minitest (unit + the 12 conformance behaviours; HTTP ones need python3) and RuboCop
```

## Releasing

Bump `KeepYourPrompts::VERSION`, update `CHANGELOG.md`, merge, and push the tag `ruby-v0.1.0`. `.github/workflows/ruby.yml` runs the tests, checks the tag against the version, copies the repository `LICENSE` into the gem and pushes it to RubyGems with **trusted publishing** (OIDC; configure the trusted publisher on rubygems.org for this repository, the `ruby.yml` workflow and the `rubygems` environment; no API key is stored).
