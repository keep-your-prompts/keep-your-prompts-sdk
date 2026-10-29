# Keep Your Prompts: PHP SDK

Read deployed prompts in microseconds from a cache shared by every PHP worker on the server, revalidate them at most once per poll interval, and keep serving when the network does not.

```php
use KeepYourPrompts\KeepYourPrompts;

$prompts = KeepYourPrompts::fromEnv();  // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
$system = $prompts->render('triage', ['company' => 'Acme', 'billing_queue' => 'refunds']);
```

- Composer package `keepyourprompts/sdk`, version 0.1.0. PHP 8.1 or newer.
- No required dependencies: ext-curl when present (keep-alive, gzip, HTTP/2), PHP stream wrappers otherwise, or any PSR-18 client you pass in. APCu is used when enabled.
- Implements [prompt delivery protocol v1](../protocol/README.md) and passes every required behaviour of the [conformance suite](../conformance/README.md). PHPStan level max.
- Laravel service provider and facade included (auto-discovered); Symfony needs only a service definition (below).
- This code is under the repository's [LICENSE](../LICENSE) (The Republic Lex Aequa License 1.0, SPDX `LicenseRef-Republic-Lex-Aequa-1.0`). Composer has no identifier for it, so `composer.json` says `"license": "proprietary"`; the release copies `LICENSE` into the published package.

## Install

```sh
composer require keepyourprompts/sdk
```

Optional, recommended under PHP-FPM: `pecl install apcu` (state then lives in shared memory instead of a file).

## Quickstart

```php
use KeepYourPrompts\KeepYourPrompts;
use KeepYourPrompts\OnMissing;

// Set KYP_DELIVERY_KEY (kypd_...), KYP_APP=support-bot and optionally KYP_ENV=prod.
$prompts = KeepYourPrompts::fromEnv();

$prompts->get('triage');                                      // the raw template
$prompts->render('triage', ['company' => 'Acme']);            // throws MissingVariable if one is missing
$prompts->render('triage', [], OnMissing::Keep);              // leaves {{company}} in place
$p = $prompts->prompt('triage');                              // Prompt: name, version, sha256, variables, text, render()
$prompts->tryGet('maybe');                                    // null when absent
print_r($prompts->status()->toArray());                       // which mirror served it, how stale it is

$prompts->onUpdate(fn (KeepYourPrompts\Update $u) =>
    error_log("prompts {$u->oldRevision} -> {$u->newRevision}: " . implode(', ', $u->changed)));
$prompts->refresh();                                          // revalidate now (cron, deploy hook, CLI)
```

Or configure in code: `new KeepYourPrompts(new Options(app: 'support-bot', deliveryKey: $key, cacheDir: '/var/cache/kyp'))`, or with a snake_case array (`new KeepYourPrompts(['app' => 'support-bot', ...])`).

## How it works in PHP

PHP is request-scoped: there is no long-lived process to run a background refresher in. So the client keeps its state (manifest, prompt bodies, ETags, mirror health) in a **store shared by every worker of the server** and follows the protocol on top of it:

1. **First call in a request** (`get`, `render`, `prompt`, ...): one `apcu_fetch`, or one small file read, then everything else in the request is served from memory. No network.
2. **Due?** If the poll interval (30 s) has passed since anyone last revalidated, the request tries a **non-blocking lock** (`apcu_add` or `flock(LOCK_NB)`). Only the winner revalidates the manifest across the mirrors with `If-None-Match` (a `304` costs nothing), fetches and verifies any new blobs, writes the disk cache and stores the new state. Every other request keeps serving what is stored (stale-while-revalidate). One request per server per interval touches the network.
3. **Nothing stored yet** (fresh server): the snapshot folder and disk cache are read first; only if neither has the manifest does the request block on the network, for at most `startupTimeout` (3 s), then throw `Unavailable` (or start empty with `startEmpty`).
4. **Failures never evict.** A mirror that fails is skipped for 0, 1, 3, 7, ... poll intervals (capped at 5 min); with all of them down, the stored prompts keep being served and `status()` reports the errors and `staleFor`.

| Store | Chosen when | Shared by |
| --- | --- | --- |
| `apcu` | `store: 'auto'` and APCu is enabled (`apc.enable_cli=1` for the CLI) | all workers of one PHP-FPM pool |
| `file` | `store: 'auto'` without APCu | every process on the machine using the same directory: `stateDir`, else `cacheDir`, else `sys_get_temp_dir()/keepyourprompts`; written with temp file + `rename`, read in one `file_get_contents` |
| `memory` | `store: 'memory'` | this process only: Octane, RoadRunner, Swoole and queue workers, where the client object lives across requests |

In long-running workers the same object is reused: it re-reads the shared store at most once per poll interval and revalidates the same way. To keep the one revalidating request off the user's latency, set `refreshOnShutdown: true`: the revalidation then runs in a shutdown function after `fastcgi_finish_request()` (PHP-FPM sends the response first). Or set `autoRefresh: false` and call `refresh()` from a scheduler every 30 s.

## With the Anthropic SDK

```php
use Anthropic\Client;
use KeepYourPrompts\KeepYourPrompts;

$prompts = KeepYourPrompts::fromEnv();
$client = new Client(); // composer require anthropic-ai/sdk; reads ANTHROPIC_API_KEY

$message = $client->messages->create(
    model: 'claude-opus-5-5',
    maxTokens: 16000,
    system: [['type' => 'text', 'text' => $prompts->render('triage', ['company' => 'Acme'])]],
    messages: [['role' => 'user', 'content' => 'My invoice is wrong.']],
);
foreach ($message->content as $block) {
    if ($block->type === 'text') {
        echo $block->text;
    }
}
```

## With the OpenAI SDK

```php
use KeepYourPrompts\KeepYourPrompts;

$prompts = KeepYourPrompts::fromEnv();
$client = OpenAI::client(getenv('OPENAI_API_KEY')); // composer require openai-php/client

$response = $client->responses()->create([
    'model' => 'gpt-5',
    'instructions' => $prompts->render('triage', ['company' => 'Acme']),
    'input' => 'My invoice is wrong.',
]);
echo $response->outputText;
```

## Laravel

The service provider and the `Prompts` facade are auto-discovered. Set `KYP_APP` and `KYP_DELIVERY_KEY` in `.env`, or publish the config:

```sh
php artisan vendor:publish --tag=keepyourprompts-config   # config/keepyourprompts.php
```

```php
use KeepYourPrompts\KeepYourPrompts;
use KeepYourPrompts\Laravel\Facades\Prompts;

$system = Prompts::render('triage', ['company' => 'Acme']);

// or inject it: a singleton per worker
public function __invoke(KeepYourPrompts $prompts) { return $prompts->get('triage'); }

// health endpoint
Route::get('/health/prompts', fn () => Prompts::status()->toArray());
```

The disk cache defaults to `storage/framework/cache/keepyourprompts`. Under Octane set `KYP_STORE=memory` (or keep APCu). To revalidate off the request path: `refresh_on_shutdown => true`, or `auto_refresh => false` plus `Schedule::call(fn () => Prompts::refresh())->everyThirtySeconds();`.

## Symfony

No bundle is needed: register the client as a service built by the factory.

```yaml
# config/services.yaml
services:
    KeepYourPrompts\KeepYourPrompts:
        factory: ['KeepYourPrompts\KeepYourPrompts', 'fromEnv']
        arguments:
            - { cache_dir: '%kernel.cache_dir%/keepyourprompts' }
```

Then autowire `KeepYourPrompts $prompts` into controllers and services. Its PSR-18 client works too: `new KeepYourPrompts($options, null, new Psr18Transport(new Psr18Client(), new Psr17Factory()))`.

## Configuration

| Option (`Options` named argument / array key) | Default | Environment (`fromEnv`) |
| --- | --- | --- |
| `app` / `app` | required | `KYP_APP` |
| `env` / `env` | `prod` | `KYP_ENV` |
| `deliveryKey` / `delivery_key` | none: no CDN/origin | `KYP_DELIVERY_KEY` |
| `snapshotDir` / `snapshot_dir` | none | `KYP_SNAPSHOT_DIR` |
| `cacheDir` / `cache_dir` | none: no disk cache | `KYP_CACHE_DIR` |
| `gitMirror`, `gitToken` / `git_mirror`, `git_token` | none | `KYP_GIT_MIRROR`, `KYP_GIT_TOKEN` |
| `workspace` / `workspace` | found by scanning `cacheDir` | `KYP_WORKSPACE` |
| `cdnBase`, `originBase` / `cdn_url`, `origin_url` | `https://cdn.keepyourprompts.com/v1/d`, `https://api.keepyourprompts.com/v1/delivery` | `KYP_CDN_URL`, `KYP_ORIGIN_URL` |
| `mirrors` / `mirrors` | snapshot, CDN, origin, git | |
| `pollInterval` / `poll_interval` | 30 s | `KYP_POLL_INTERVAL` (seconds) |
| `store` / `store` | `auto` (APCu, else file) | `KYP_STORE` |
| `stateDir` / `state_dir` | `cacheDir`, else the temp dir | |
| `autoRefresh` / `auto_refresh` | `true` | |
| `refreshOnShutdown` / `refresh_on_shutdown` | `false` | |
| `connectTimeout`, `requestTimeout` | 2 s, 5 s | |
| `startupTimeout` / `startup_timeout` | 3 s | |
| `startEmpty` / `start_empty` | `false` | |
| `maxBackoff` / `max_backoff` | 300 s | |
| `userAgent` / `user_agent` | `kyp-php/0.1.0` | |
| `logger` / `logger` | `error_log()`: `fn (string $level, string $message) => ...` | |
| `logLevel` / `log_level` | `warn` | `KYP_LOG=debug\|info\|warn\|error\|off` |

`mirrors` replaces the defaults with your own ordered list of `Mirror::file($dir, $name)` and `Mirror::http($baseUrl, $name, $bearerToken)`; the disk cache still applies. To send the delivery key as a header to the origin instead of in the path: `Mirror::http('https://api.keepyourprompts.com/v1/delivery', 'origin', $key)`. The delivery key never appears in logs, exceptions or `status()` (shortened to `kypd_Ab3d...`).

## Availability: mirrors

Every copy of your prompts uses the same layout (`envs/<app>/<env>.json`, `blobs/<sha256>`), so the client treats them as interchangeable mirrors:

| # | Mirror | Name in `status()` | Enabled when |
| --- | --- | --- | --- |
| 1 | Snapshot folder | `snapshot` | `snapshotDir` / `KYP_SNAPSHOT_DIR` |
| 2 | Disk cache written by the SDK | `disk-cache` | `cacheDir` / `KYP_CACHE_DIR` |
| 3 | CDN `https://cdn.keepyourprompts.com/v1/d/<key>` | `cdn` | a delivery key is set |
| 4 | Origin `https://api.keepyourprompts.com/v1/delivery/<key>` | `origin` | a delivery key is set |
| 5 | Your git repo (`.kyp/` written by the sync) | `git` | `gitMirror` / `KYP_GIT_MIRROR` (+ `KYP_GIT_TOKEN`, sent as `Authorization: Bearer`) |

Start-up reads the local mirrors (1, 2) and keeps the highest revision; revalidation asks 3 to 5 in order and stops at the first that answers. Every blob is checked with SHA-256 wherever it came from, a manifest with a lower revision than the one held is ignored, and a manifest for another app/env or with a schema other than 1 is rejected. With no network mirror configured the snapshot folder itself is polled, so a folder kept current by `git pull` or a sidecar is picked up live. The disk cache uses the same layout as the other SDKs (`<cacheDir>/<workspace>/<app>/<env>/`), so PHP and, say, a Python worker can share one directory.

## Snapshots

`kyp pull --app support-bot --env prod --out ./prompts` writes a complete mirror to a folder. Commit it or bake it into the image and set `KYP_SNAPSHOT_DIR=./prompts`: a fresh server then answers its first request with zero network, and upgrades within one poll interval once a network mirror answers.

## API

| `KeepYourPrompts` | |
| --- | --- |
| `__construct(Options\|array $options, ?StateStore $store = null, ?Transport $transport = null)` | Nothing is loaded until the first read. |
| `static fromEnv(array $overrides = [], ...)` | `KYP_*` variables plus snake_case overrides. |
| `get(string $name): string` | Raw template. Throws `NotFound`, or `Unavailable` when nothing could be loaded. |
| `tryGet(string $name): ?string`, `has(string $name): bool` | |
| `prompt(string $name): Prompt` | `name`, `version`, `sha256`, `variables`, `text`, `render(array $vars)`. |
| `render(string $name, array $vars = [], OnMissing $onMissing = OnMissing::Error): string` | `OnMissing::Keep` leaves `{{name}}`, `OnMissing::Empty` drops it. Throws `MissingVariable` (`->names`). |
| `names(): list<string>`, `revision(): int` | |
| `onUpdate(callable(Update): void): self` | Called in the process that swapped in a new revision (`oldRevision`, `newRevision`, `source`, `changed`). Exceptions are caught and logged. |
| `refresh(): bool` | Revalidate now, ignoring the interval and backoff. `true` if a mirror answered. |
| `status(): Status` | `ready`, `source`, `revision`, `workspace`, `deployedAt`, `promptCount`, `lastSuccess`, `lastCheck`, `lastError`, `staleFor` (seconds), `store`, `mirrors` (per mirror `consecutiveFailures`, `lastError`, `lastSuccess`); `toArray()` for JSON. |

`Template::render()` and `Template::variables()` are the pure template functions; `Manifest::parse()` validates a manifest. All exceptions extend `KeepYourPrompts\Exception\KypException` (a `RuntimeException`): `NotFound`, `MissingVariable`, `Unavailable`, `ProtocolError`.

## Development

```sh
composer update
vendor/bin/phpunit           # unit tests + the 12 conformance behaviours (HTTP ones need python3 for conformance/fake_cdn.py)
vendor/bin/phpstan analyse   # level max
```

## Releasing

Packagist reads `composer.json` from the **root** of a repository and takes versions from its tags; it has no support for a package in a subdirectory of a monorepo (Private Packagist's multi-package repositories do, packagist.org does not), and a monorepo tag like `php-v0.1.0` is not a Composer version. So this directory is published through a read-only **split mirror**, `github.com/keep-your-prompts/kyp-php`:

1. Bump `Options::VERSION`, update `CHANGELOG.md`, merge.
2. Push the tag `php-v0.1.0`. `.github/workflows/php.yml` runs the tests, checks the tag against the version, copies `php/` (and the repository `LICENSE`) to the mirror's `main`, and tags it `v0.1.0`.
3. Packagist's GitHub hook on the mirror publishes `keepyourprompts/sdk` 0.1.0. If `secrets.PACKAGIST_TOKEN` and `vars.PACKAGIST_USERNAME` are set, the workflow also calls Packagist's update API.

One-time setup: create the mirror repository, register it on packagist.org as `keepyourprompts/sdk` (enable the GitHub hook), and store a fine-grained token with contents read/write on the mirror only as `secrets.PHP_MIRROR_TOKEN` in the `packagist` environment. Never commit to the mirror by hand.
