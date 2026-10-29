<?php

declare(strict_types=1);

namespace KeepYourPrompts;

use KeepYourPrompts\Exception\KypException;
use KeepYourPrompts\Exception\MissingVariable;
use KeepYourPrompts\Exception\NotFound;
use KeepYourPrompts\Exception\Unavailable;
use KeepYourPrompts\Http\CurlTransport;
use KeepYourPrompts\Http\StreamTransport;
use KeepYourPrompts\Http\Transport;
use KeepYourPrompts\Internal\Engine;
use KeepYourPrompts\Internal\State;
use KeepYourPrompts\Store\ApcuStore;
use KeepYourPrompts\Store\FileStore;
use KeepYourPrompts\Store\MemoryStore;
use KeepYourPrompts\Store\StateStore;
use KeepYourPrompts\Telemetry\Observer;
use KeepYourPrompts\Telemetry\RenderError;

/**
 * Keep Your Prompts client for PHP.
 *
 *     $prompts = KeepYourPrompts::fromEnv();            // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
 *     $system  = $prompts->render('triage', ['company' => 'Acme']);
 *
 * PHP is request-scoped, so the state lives in a store shared by every process on the
 * server (APCu, else a file). get() reads it once per request and then serves from
 * memory. At most once per poll interval, one process (whoever wins a non-blocking
 * lock) revalidates the manifest across the mirrors with If-None-Match; every other
 * request keeps serving what is stored. Failures never evict what is held.
 */
final class KeepYourPrompts
{
    public const VERSION = Options::VERSION;

    private readonly Options $options;
    private readonly Engine $engine;
    private readonly StateStore $store;
    private readonly string $key;
    private ?State $state = null;
    private float $loadedAt = 0.0;
    private bool $shutdownScheduled = false;
    /** @var list<callable(Update): void> */
    private array $listeners = [];
    /** @var array<int, Observer> */
    private array $observers = [];

    /**
     * @param Options|array<string, mixed> $options an Options object or a config array (see Options::fromArray)
     */
    public function __construct(Options|array $options, ?StateStore $store = null, ?Transport $transport = null)
    {
        $this->options = is_array($options) ? Options::fromArray($options) : $options;
        $o = $this->options;
        $transport ??= extension_loaded('curl') ? new CurlTransport() : new StreamTransport();
        $this->engine = new Engine($o, $transport, \Closure::fromCallable([$this, 'log']));
        $this->key = $this->engine->key();
        if ($o->observer !== null) {
            $this->observers[spl_object_id($o->observer)] = $o->observer;
        }
        $this->store = $store ?? match ($o->store === 'auto' ? (ApcuStore::available() ? 'apcu' : 'file') : $o->store) {
            'apcu' => new ApcuStore(),
            'memory' => new MemoryStore(),
            default => new FileStore($o->stateDir ?? $o->cacheDir ?? sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'keepyourprompts'),
        };
    }

    /**
     * @param array<string, mixed> $overrides snake_case options applied on top of the KYP_* environment
     */
    public static function fromEnv(array $overrides = [], ?StateStore $store = null, ?Transport $transport = null): self
    {
        return new self(Options::fromEnv($overrides), $store, $transport);
    }

    /**
     * Raw template of a prompt.
     *
     * @throws NotFound
     * @throws Unavailable when nothing could be loaded at all (see Options::$startEmpty)
     */
    public function get(string $name): string
    {
        return $this->find($name)->text;
    }

    public function tryGet(string $name): ?string
    {
        return $this->state()->prompts[$name]->text ?? null;
    }

    public function has(string $name): bool
    {
        return isset($this->state()->prompts[$name]);
    }

    /**
     * Name, version, sha256, variables and text.
     *
     * @throws NotFound
     * @throws Unavailable
     */
    public function prompt(string $name): Prompt
    {
        return $this->find($name);
    }

    /**
     * @param array<string, string|int|float|bool|\Stringable|null> $vars
     *
     * @throws NotFound
     * @throws MissingVariable
     * @throws Unavailable
     */
    public function render(string $name, array $vars = [], OnMissing $onMissing = OnMissing::Error): string
    {
        try {
            return Template::render($this->find($name)->text, $vars, $onMissing);
        } catch (NotFound|MissingVariable $e) {
            $this->renderFailed($name, $e);

            throw $e;
        }
    }

    /**
     * Which deployed body $name is: name, version, sha256, app, env, workspace, revision and
     * the mirror kind that served it (protocol/tracing.md). Memory only.
     *
     * @throws NotFound
     * @throws Unavailable
     */
    public function meta(string $name): PromptMeta
    {
        $s = $this->state();

        return $this->metaOf($this->findIn($s, $name), $s);
    }

    /**
     * render() plus the metadata of the exact body rendered (one consistent state).
     *
     * @param array<string, string|int|float|bool|\Stringable|null> $vars
     *
     * @throws NotFound
     * @throws MissingVariable
     * @throws Unavailable
     */
    public function renderWithMeta(string $name, array $vars = [], OnMissing $onMissing = OnMissing::Error): Rendered
    {
        $s = $this->state();
        try {
            $p = $this->findIn($s, $name);

            return new Rendered(Template::render($p->text, $vars, $onMissing), $this->metaOf($p, $s));
        } catch (NotFound|MissingVariable $e) {
            $this->renderFailed($name, $e);

            throw $e;
        }
    }

    /**
     * Subscribe to delivery telemetry: refresh rounds run by this process and render errors.
     * Returns a closure that unsubscribes.
     *
     * @return \Closure(): void
     */
    public function addObserver(Observer $observer): \Closure
    {
        $id = spl_object_id($observer);
        $this->observers[$id] = $observer;

        return function () use ($id): void {
            unset($this->observers[$id]);
        };
    }

    /**
     * @return list<string> prompt names in the current revision
     */
    public function names(): array
    {
        return array_map('strval', array_keys($this->state()->prompts));
    }

    /** Current revision, 0 when nothing is loaded. */
    public function revision(): int
    {
        return $this->state()->revision;
    }

    /**
     * Call $callback after this process swaps in a new revision (during get() or
     * refresh()). Other processes see the new state without callbacks.
     *
     * @param callable(Update): void $callback
     */
    public function onUpdate(callable $callback): self
    {
        $this->listeners[] = $callback;

        return $this;
    }

    /**
     * Revalidate now across the mirrors, ignoring the poll interval and backoff.
     * Returns true when a mirror answered.
     */
    public function refresh(): bool
    {
        $this->load();

        return $this->revalidate(true);
    }

    /**
     * Health, for logs, metrics and health endpoints. Loads the state like get() does
     * (so the first call of a cold server may hit the network) but never revalidates,
     * and reports a failed start-up instead of throwing.
     */
    public function status(): Status
    {
        try {
            $s = $this->load();
        } catch (Unavailable $e) {
            $s = new State();
            $s->lastError = $e->getMessage();
        }
        $now = microtime(true);

        return new Status(
            ready: $s->ready,
            source: $s->source,
            revision: $s->revision,
            workspace: $s->workspace,
            deployedAt: $s->deployedAt,
            promptCount: count($s->prompts),
            lastSuccess: $s->lastSuccess === null ? null : Engine::date($s->lastSuccess),
            lastCheck: $s->checkedAt > 0 ? Engine::date($s->checkedAt) : null,
            lastError: $s->lastError,
            staleFor: max(0.0, $now - ($s->lastSuccess ?? $s->createdAt)),
            store: $this->store->name(),
            mirrors: $this->engine->mirrorStatuses($s),
        );
    }

    /** The configuration this client was built with. */
    public function options(): Options
    {
        return $this->options;
    }

    /** The store key of this configuration (to inspect or clear the shared state). */
    public function storeKey(): string
    {
        return $this->key;
    }

    // ---------------------------------------------------------------------------------

    private function find(string $name): Prompt
    {
        return $this->findIn($this->state(), $name);
    }

    private function findIn(State $s, string $name): Prompt
    {
        if (isset($s->prompts[$name])) {
            return $s->prompts[$name];
        }

        throw new NotFound($name, $s->ready ? sprintf('%s revision %d', $this->engine->describe(), $s->revision) : 'nothing loaded for ' . $this->engine->describe());
    }

    /**
     * The read path: in-process state after the first call; the shared store is read
     * again only once per poll interval (long-running workers), and a due
     * revalidation is attempted by at most one process.
     */
    private function state(): State
    {
        $s = $this->load();
        if ($this->options->autoRefresh && $this->due($s, microtime(true))) {
            if ($this->options->refreshOnShutdown) {
                $this->scheduleShutdownRefresh();
            } else {
                $this->revalidate(false);
                $s = $this->state ?? $s;
            }
        }

        return $s;
    }

    private function load(): State
    {
        $now = microtime(true);
        if ($this->state !== null && $now - $this->loadedAt < max($this->options->pollInterval, 0.001)) {
            return $this->state;
        }
        $s = $this->store->load($this->key);
        if ($s === null && $this->state !== null) {
            $s = $this->state; // the store was cleared or evicted: keep what we hold
            $this->save($s);
        }
        if ($s === null) {
            try {
                $s = $this->bootstrap();
            } finally {
                $this->notifyRefreshes();
            }
        }
        $this->state = $s;
        $this->loadedAt = $now;

        return $s;
    }

    /**
     * Nothing in the store: local mirrors first (snapshot, disk cache), then the network
     * for up to startupTimeout.
     */
    private function bootstrap(): State
    {
        $s = new State();
        $this->engine->loadLocal($s);
        if (!$s->ready && $this->engine->hasNetwork()) {
            $this->engine->startupFromNetwork($s, microtime(true) + $this->options->startupTimeout);
        }
        if (!$s->ready && !$this->options->startEmpty) {
            throw new Unavailable(sprintf(
                'kyp: could not load %s: %s',
                $this->engine->describe(),
                $s->lastError !== '' ? $s->lastError : 'no snapshot or disk cache found and no remote mirror configured (set KYP_DELIVERY_KEY, KYP_SNAPSHOT_DIR or KYP_CACHE_DIR)',
            ));
        }
        if (!$s->ready) {
            $this->log('warn', 'starting empty, will keep trying: ' . $s->lastError);
        }
        $s->checkedAt = microtime(true);
        $this->save($s);

        return $s;
    }

    private function due(State $s, float $now): bool
    {
        $interval = $s->ready ? $this->options->pollInterval : min($this->options->pollInterval, 1.0);

        return $now - $s->checkedAt >= $interval;
    }

    private function revalidate(bool $force): bool
    {
        $ttl = max(10.0, 2 * ($this->options->connectTimeout + $this->options->requestTimeout) * max(1, $this->engine->mirrorCount()));
        $locked = $this->store->lock($this->key, $ttl);
        if (!$locked && !$force) {
            return false; // another process is revalidating; keep serving what is stored
        }
        $update = null;
        $answered = false;
        try {
            $fresh = $this->store->load($this->key) ?? $this->state ?? new State();
            if (!$force && !$this->due($fresh, microtime(true))) {
                $this->adopt($fresh);

                return true;
            }
            $s = clone $fresh;
            [$answered, $update] = $this->engine->round($s, $force, null, $force ? 'manual' : 'poll');
            $s->checkedAt = microtime(true);
            $this->save($s);
            $this->adopt($s);
        } finally {
            if ($locked) {
                $this->store->unlock($this->key);
            }
            $this->notifyRefreshes();
        }
        if ($update !== null && $update->oldRevision !== 0) {
            foreach ($this->listeners as $cb) {
                try {
                    $cb($update);
                } catch (\Throwable $e) {
                    $this->log('error', 'onUpdate callback threw: ' . $e->getMessage());
                }
            }
        }

        return $answered;
    }

    private function metaOf(Prompt $p, State $s): PromptMeta
    {
        return new PromptMeta(
            $p->name,
            $p->version,
            $p->sha256,
            $this->options->app,
            $this->options->env,
            $s->workspace,
            $s->revision,
            $this->engine->sourceOf($s->source),
        );
    }

    private function renderFailed(string $name, KypException $e): void
    {
        if ($this->observers === []) {
            return;
        }
        $error = new RenderError($this->options->app, $this->options->env, $name, $e instanceof MissingVariable ? 'missing_variable' : 'not_found');
        foreach ($this->observers as $o) {
            try {
                $o->onRenderError($error);
            } catch (\Throwable $t) {
                $this->log('error', 'observer threw: ' . $t->getMessage());
            }
        }
    }

    /** Hand the finished refresh rounds to the observers (called with no lock held). */
    private function notifyRefreshes(): void
    {
        $records = $this->engine->takeRecords();
        foreach ($records as $r) {
            foreach ($this->observers as $o) {
                try {
                    $o->onRefresh($r);
                } catch (\Throwable $t) {
                    $this->log('error', 'observer threw: ' . $t->getMessage());
                }
            }
        }
    }

    private function adopt(State $s): void
    {
        $this->state = $s;
        $this->loadedAt = microtime(true);
    }

    private function save(State $s): void
    {
        try {
            $this->store->save($this->key, $s);
        } catch (\Throwable $e) {
            $this->log('warn', sprintf('%s store write failed: %s', $this->store->name(), $e->getMessage()));
        }
    }

    private function scheduleShutdownRefresh(): void
    {
        if ($this->shutdownScheduled) {
            return;
        }
        $this->shutdownScheduled = true;
        register_shutdown_function(function (): void {
            if (function_exists('fastcgi_finish_request')) {
                fastcgi_finish_request();
            }
            try {
                $this->revalidate(false);
            } catch (KypException $e) {
                $this->log('error', 'refresh error: ' . $e->getMessage());
            }
        });
    }

    private function log(string $level, string $message): void
    {
        $levels = Options::LOG_LEVELS;
        if (($levels[$level] ?? 0) < $levels[$this->options->logLevel]) {
            return;
        }
        if ($this->options->logger !== null) {
            try {
                ($this->options->logger)($level, $message);
            } catch (\Throwable) {
            }

            return;
        }
        error_log('[kyp] ' . $level . ': ' . $message);
    }
}
