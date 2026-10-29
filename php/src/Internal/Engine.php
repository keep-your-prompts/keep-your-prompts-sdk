<?php

declare(strict_types=1);

namespace KeepYourPrompts\Internal;

use KeepYourPrompts\Exception\ProtocolError;
use KeepYourPrompts\Exception\TransportException;
use KeepYourPrompts\Http\Transport;
use KeepYourPrompts\Manifest;
use KeepYourPrompts\Mirror;
use KeepYourPrompts\MirrorStatus;
use KeepYourPrompts\Options;
use KeepYourPrompts\Prompt;
use KeepYourPrompts\Template;
use KeepYourPrompts\Update;

/**
 * Mirror access and the refresh algorithm of protocol v1. Stateless between calls:
 * everything that must survive the request is in the State it is handed.
 *
 * @internal
 */
final class Engine
{
    public const FILE = 'file';
    public const CACHE = 'cache';
    public const HTTP = 'http';

    /** @var list<array{mirror: Mirror, kind: self::FILE|self::CACHE|self::HTTP}> */
    private array $mirrors = [];
    /** @var list<int> mirrors polled by refresh rounds, in order */
    private array $polled = [];
    private ?int $cacheIdx = null;
    private ?string $cacheRoot = null;
    private bool $cacheLocated = false;

    /**
     * @param \Closure(string, string): void $log
     */
    public function __construct(
        private readonly Options $o,
        private readonly Transport $http,
        private readonly \Closure $log,
    ) {
        $list = $o->mirrors;
        if ($list === null) {
            $list = [];
            if ($o->snapshotDir !== null) {
                $list[] = Mirror::file($o->snapshotDir, 'snapshot');
            }
            if ($o->deliveryKey !== null) {
                $list[] = Mirror::http(rtrim($o->cdnBase, '/') . '/' . $o->deliveryKey, 'cdn');
                $list[] = Mirror::http(rtrim($o->originBase, '/') . '/' . $o->deliveryKey, 'origin');
            }
            if ($o->gitMirror !== null) {
                $list[] = Mirror::http($o->gitMirror, 'git', $o->gitToken ?? '');
            }
        }
        foreach ($list as $m) {
            if ($this->cacheIdx === null && $o->cacheDir !== null && $m->isHttp()) {
                $this->addCache();
            }
            $this->mirrors[] = ['mirror' => $m, 'kind' => $m->isHttp() ? self::HTTP : self::FILE];
        }
        if ($this->cacheIdx === null && $o->cacheDir !== null) {
            $this->addCache();
        }
        foreach ($this->mirrors as $i => $m) {
            if ($m['kind'] === self::HTTP) {
                $this->polled[] = $i;
            }
        }
        if ($this->polled === []) {
            // No network mirror: poll the folders, so a snapshot kept current by a sidecar is picked up live.
            foreach ($this->mirrors as $i => $m) {
                if ($m['kind'] === self::FILE) {
                    $this->polled[] = $i;
                }
            }
        }
    }

    /** A stable identifier of this configuration, used as the store key. */
    public function key(): string
    {
        $parts = [State::FORMAT, $this->o->app, $this->o->env, $this->o->workspace, $this->o->cacheDir];
        foreach ($this->mirrors as $m) {
            $parts[] = $m['mirror']->name . '=' . $m['mirror']->url;
        }

        return $this->o->app . '-' . $this->o->env . '-' . substr(hash('sha256', implode("\n", array_map('strval', $parts))), 0, 16);
    }

    public function mirrorCount(): int
    {
        return count($this->mirrors);
    }

    public function hasNetwork(): bool
    {
        foreach ($this->mirrors as $m) {
            if ($m['kind'] === self::HTTP) {
                return true;
            }
        }

        return false;
    }

    public function describe(): string
    {
        return $this->o->app . '/' . $this->o->env;
    }

    /**
     * Start-up from local mirrors only (snapshot folders, disk cache): the highest
     * revision wins, ties go to the earlier mirror.
     */
    public function loadLocal(State $s): void
    {
        $this->locateCache();
        $best = null;
        $errors = [];
        foreach ($this->mirrors as $i => $m) {
            if ($m['kind'] === self::HTTP) {
                continue;
            }
            $a = $this->attempt($i, $best === null ? null : $best[0]->revision, [], '');
            if ($a->outcome === Attempt::UPDATED && $a->manifest !== null) {
                $best = [$a->manifest, $a->raw, $a->prompts, $i];
            } elseif ($a->outcome === Attempt::FAILED && !$a->missing) {
                $errors[] = $m['mirror']->name . ': ' . $a->error;
                $this->log('warn', $m['mirror']->name . ': ' . $a->error);
            }
        }
        $s->lastError = implode('; ', $errors);
        if ($best !== null) {
            [$man, $raw, $prompts, $i] = $best;
            $this->install($s, $man, $raw, $prompts, $this->mirrors[$i]['mirror']->name);
            if ($i !== $this->cacheIdx) {
                $this->writeCache($s);
            }
        }
    }

    /**
     * Nothing local: retry the network mirrors until one answers or the deadline passes.
     */
    public function startupFromNetwork(State $s, float $deadline): void
    {
        $delay = 0.1;
        while (true) {
            [$answered] = $this->round($s, true, $deadline); // nothing held, so answered means loaded
            if ($answered || microtime(true) + $delay >= $deadline) {
                return;
            }
            usleep((int) ($delay * 1e6));
            $delay = min($delay * 2, 1.0);
        }
    }

    /**
     * One refresh round over the polled mirrors, in order, stopping at the first that
     * answers. Mutates $s. Returns whether a mirror answered and the update, if any.
     *
     * @return array{bool, ?Update}
     */
    public function round(State $s, bool $ignoreBackoff, ?float $deadline = null): array
    {
        $this->locateCache();
        $errors = [];
        $skipped = [];
        $update = null;
        $answered = false;
        $try = function (int $i) use ($s, &$errors, &$update): bool {
            $name = $this->mirrors[$i]['mirror']->name;
            $a = $this->attempt($i, $s->ready ? $s->revision : null, $s->ready ? $s->bySha() : [], $s->ready ? ($s->etags[$name] ?? '') : '');
            $now = microtime(true);
            switch ($a->outcome) {
                case Attempt::UPDATED:
                    if ($a->manifest === null) {
                        return false;
                    }
                    $s->etags[$name] = $a->etag;
                    $update = $this->install($s, $a->manifest, $a->raw, $a->prompts, $name);
                    $this->writeCache($s);
                    $this->recordOk($s, $name, $now);

                    return true;
                case Attempt::UNCHANGED:
                    if ($a->etag !== '') {
                        $s->etags[$name] = $a->etag;
                    }
                    $this->recordOk($s, $name, $now);
                    if ($s->ready) {
                        $s->source = $name;
                    }

                    return true;
                case Attempt::STALE:
                    $errors[] = $name . ': ' . $a->error;
                    $s->health($name)->lastError = $a->error;

                    return false;
                default:
                    $errors[] = $name . ': ' . $a->error;
                    $this->recordFail($s, $name, $a->error, $now);

                    return false;
            }
        };
        $now = microtime(true);
        foreach ($this->polled as $i) {
            if ($deadline !== null && microtime(true) >= $deadline) {
                break;
            }
            if (!$ignoreBackoff && $s->health($this->mirrors[$i]['mirror']->name)->retryAt > $now) {
                $skipped[] = $i;
                continue;
            }
            if ($answered = $try($i)) {
                break;
            }
        }
        if (!$answered) {
            // Everything we tried failed: give the mirrors in backoff a chance too.
            foreach ($skipped as $i) {
                if ($answered = $try($i)) {
                    break;
                }
            }
        }
        if ($answered) {
            $s->lastSuccess = microtime(true);
        }
        $joined = implode('; ', $errors);
        $s->lastError = (!$answered && $joined === '') ? 'all mirrors backing off' : $joined;
        if (!$answered) {
            $this->log('warn', 'refresh failed, serving what is held: ' . $s->lastError);
        }

        return [$answered, $update];
    }

    /**
     * @return list<MirrorStatus>
     */
    public function mirrorStatuses(State $s): array
    {
        $out = [];
        foreach ($this->mirrors as $i => $m) {
            $name = $m['mirror']->name;
            $h = $s->health[$name] ?? new MirrorHealth();
            $url = $i === $this->cacheIdx ? ($this->o->cacheDir ?? '') : $m['mirror']->url;
            $out[] = new MirrorStatus(
                $name,
                $this->redact($url),
                $h->failures,
                $h->lastError,
                $h->lastSuccess === null ? null : self::date($h->lastSuccess),
            );
        }

        return $out;
    }

    public static function date(float $ts): \DateTimeImmutable
    {
        return \DateTimeImmutable::createFromFormat('U.u', sprintf('%.6F', $ts)) ?: new \DateTimeImmutable('@' . (int) $ts);
    }

    public function redact(string $text): string
    {
        $key = $this->o->deliveryKey;
        if ($key === null || strlen($key) < 8) {
            return $text;
        }

        return str_replace($key, substr($key, 0, 9) . '...', $text);
    }

    // --- internals ---------------------------------------------------------------

    private function addCache(): void
    {
        $this->cacheIdx = count($this->mirrors);
        $this->mirrors[] = ['mirror' => new Mirror('disk-cache', (string) $this->o->cacheDir), 'kind' => self::CACHE];
    }

    private function manifestPath(): string
    {
        return 'envs/' . $this->o->app . '/' . $this->o->env . '.json';
    }

    private function log(string $level, string $message): void
    {
        ($this->log)($level, $this->redact($message));
    }

    private function fetch(int $i, string $rel, string $etag): FetchResult
    {
        $m = $this->mirrors[$i];
        if ($m['kind'] === self::CACHE) {
            return $this->cacheRoot === null ? FetchResult::notFound('empty') : FetchResult::readFile($this->cacheRoot . '/' . $rel);
        }
        if ($m['kind'] === self::FILE) {
            return FetchResult::readFile(rtrim($m['mirror']->path(), '/\\') . '/' . $rel);
        }
        $headers = ['User-Agent' => $this->o->userAgent, 'Accept' => '*/*'];
        if ($etag !== '') {
            $headers['If-None-Match'] = $etag;
        }
        if ($m['mirror']->bearerToken !== '') {
            $headers['Authorization'] = 'Bearer ' . $m['mirror']->bearerToken;
        }
        try {
            $r = $this->http->get(rtrim($m['mirror']->url, '/') . '/' . $rel, $headers, $this->o->connectTimeout, $this->o->requestTimeout);
        } catch (TransportException $e) {
            return FetchResult::failed($this->redact($e->getMessage()));
        }

        return match (true) {
            $r->status === 200 => FetchResult::ok($r->body, $r->header('etag')),
            $r->status === 304 => new FetchResult(FetchResult::NOT_MODIFIED, '', $r->header('etag') !== '' ? $r->header('etag') : $etag),
            $r->status === 404 => FetchResult::notFound('HTTP 404'),
            default => FetchResult::failed('HTTP ' . $r->status),
        };
    }

    /**
     * Fetch, parse and (when newer than $heldRevision) assemble a manifest from mirror $i.
     *
     * @param array<string, string> $have bodies already held, by sha256
     */
    private function attempt(int $i, ?int $heldRevision, array $have, string $etag): Attempt
    {
        $r = $this->fetch($i, $this->manifestPath(), $etag);
        if ($r->kind === FetchResult::NOT_MODIFIED) {
            return new Attempt(Attempt::UNCHANGED, etag: $r->etag);
        }
        if ($r->kind !== FetchResult::OK) {
            $missing = $r->kind === FetchResult::NOT_FOUND;

            return new Attempt(Attempt::FAILED, error: $missing ? 'manifest not found (' . $r->error . ')' : $r->error, missing: $missing);
        }
        try {
            $man = Manifest::parse($r->body, $this->o->app, $this->o->env);
        } catch (ProtocolError $e) {
            return new Attempt(Attempt::FAILED, error: 'bad manifest: ' . $e->getMessage());
        }
        if ($heldRevision !== null && $man->revision < $heldRevision) {
            return new Attempt(Attempt::STALE, error: sprintf('stale manifest ignored (revision %d < held %d)', $man->revision, $heldRevision));
        }
        if ($heldRevision !== null && $man->revision === $heldRevision) {
            return new Attempt(Attempt::UNCHANGED, etag: $r->etag);
        }
        $prompts = [];
        $fetched = [];
        foreach ($man->prompts as $name => $mp) {
            $text = $have[$mp->sha256] ?? $fetched[$mp->sha256] ?? null;
            if ($text === null) {
                $err = '';
                $text = $this->resolveBlob($i, $mp->sha256, $err);
                if ($text === null) {
                    return new Attempt(Attempt::FAILED, error: $err);
                }
                $fetched[$mp->sha256] = $text;
            }
            $prompts[$name] = new Prompt($name, $mp->version, $mp->sha256, $mp->variables !== [] ? $mp->variables : Template::variables($text), $text);
        }

        return new Attempt(Attempt::UPDATED, $man, $r->body, $prompts, $r->etag);
    }

    /**
     * A blob may come from any mirror: disk cache first, then the mirror that served the
     * manifest, then the others. Every copy is verified with SHA-256.
     */
    private function resolveBlob(int $mi, string $sha, string &$err): ?string
    {
        $order = array_unique(array_merge($this->cacheIdx === null ? [] : [$this->cacheIdx], [$mi], array_keys($this->mirrors)));
        $errors = [];
        foreach ($order as $i) {
            $r = $this->fetch($i, 'blobs/' . $sha, '');
            if ($r->kind !== FetchResult::OK) {
                if ($i === $mi) {
                    $errors[] = $this->mirrors[$i]['mirror']->name . ': ' . $r->error;
                }
                continue;
            }
            if (hash('sha256', $r->body) !== $sha) {
                $msg = 'blob ' . substr($sha, 0, 12) . ' failed sha256 verification';
                $this->log('warn', $this->mirrors[$i]['mirror']->name . ': ' . $msg . ' (discarded)');
                $errors[] = $this->mirrors[$i]['mirror']->name . ': ' . $msg;
                continue;
            }

            return $r->body;
        }
        $err = 'blob ' . substr($sha, 0, 12) . ' unavailable' . ($errors === [] ? '' : ' (' . implode('; ', $errors) . ')');

        return null;
    }

    /**
     * @param array<string, Prompt> $prompts
     */
    private function install(State $s, Manifest $man, string $raw, array $prompts, string $source): Update
    {
        $old = $s->ready ? $s->prompts : [];
        $changed = [];
        foreach ($prompts as $name => $p) {
            if (!isset($old[$name]) || $old[$name]->sha256 !== $p->sha256) {
                $changed[] = (string) $name;
            }
        }
        foreach ($old as $name => $p) {
            if (!isset($prompts[$name])) {
                $changed[] = (string) $name;
            }
        }
        sort($changed, SORT_STRING);
        $update = new Update($s->ready ? $s->revision : 0, $man->revision, $source, $changed);
        $s->ready = true;
        $s->revision = $man->revision;
        $s->workspace = $man->workspace;
        $s->deployedAt = $man->deployedAt;
        $s->rawManifest = $raw;
        $s->prompts = $prompts;
        $s->source = $source;
        if ($update->oldRevision !== 0) {
            $this->log('info', sprintf('%s: revision %d -> %d from %s', $this->describe(), $update->oldRevision, $update->newRevision, $source));
        }

        return $update;
    }

    private function recordOk(State $s, string $name, float $now): void
    {
        $h = $s->health($name);
        if ($h->failures > 0) {
            $this->log('info', $name . ' is answering again');
        }
        $h->failures = 0;
        $h->retryAt = 0.0;
        $h->lastError = '';
        $h->lastSuccess = $now;
    }

    private function recordFail(State $s, string $name, string $error, float $now): void
    {
        $h = $s->health($name);
        $h->lastError = $error;
        $h->failures++;
        // Skip the mirror for 0, 1, 3, 7, ... poll intervals, capped at maxBackoff.
        $mult = (1 << min($h->failures - 1, 20)) - 1;
        $wait = min($this->o->pollInterval * $mult, $this->o->maxBackoff);
        $h->retryAt = $now + $wait * (0.9 + mt_rand() / mt_getrandmax() * 0.2);
        $this->log($h->failures === 1 ? 'warn' : 'debug', $name . ': ' . $error);
    }

    // --- disk cache: <cache_dir>/<workspace>/<app>/<env>/ in the protocol layout ----

    private function cacheRootFor(string $workspace): string
    {
        return rtrim((string) $this->o->cacheDir, '/\\') . '/' . $workspace . '/' . $this->o->app . '/' . $this->o->env;
    }

    private function locateCache(): void
    {
        if ($this->cacheIdx === null || $this->cacheLocated) {
            return;
        }
        $this->cacheLocated = true;
        if ($this->o->workspace !== null) {
            $this->cacheRoot = $this->cacheRootFor($this->o->workspace);

            return;
        }
        $best = -1;
        foreach (glob(rtrim((string) $this->o->cacheDir, '/\\') . '/*/' . $this->o->app . '/' . $this->o->env . '/' . $this->manifestPath()) ?: [] as $file) {
            $body = @file_get_contents($file);
            if (!is_string($body)) {
                continue;
            }
            try {
                $m = Manifest::parse($body, $this->o->app, $this->o->env);
            } catch (ProtocolError) {
                continue;
            }
            if ($m->revision > $best) {
                $best = $m->revision;
                $this->cacheRoot = $this->cacheRootFor($m->workspace);
            }
        }
    }

    private function writeCache(State $s): void
    {
        if ($this->cacheIdx === null || !$s->ready) {
            return;
        }
        $root = $this->cacheRootFor($s->workspace);
        try {
            foreach ($s->prompts as $p) {
                $blob = $root . '/blobs/' . $p->sha256;
                if (!is_file($blob)) {
                    self::atomicWrite($blob, $p->text);
                }
            }
            $path = $root . '/' . $this->manifestPath();
            $existing = @file_get_contents($path);
            if (is_string($existing)) {
                if ($existing === $s->rawManifest) {
                    $this->cacheRoot = $root;

                    return;
                }
                try {
                    if (Manifest::parse($existing, $this->o->app, $this->o->env)->revision > $s->revision) {
                        return;
                    }
                } catch (ProtocolError) {
                }
            }
            self::atomicWrite($path, $s->rawManifest);
            $this->cacheRoot = $root;
        } catch (\RuntimeException $e) {
            $this->log('warn', 'disk cache write failed: ' . $e->getMessage());
        }
    }

    /** Temp file, fsync, rename: readers see the old file or the new one, never half. */
    public static function atomicWrite(string $path, string $data): void
    {
        $dir = dirname($path);
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new \RuntimeException('cannot create ' . $dir);
        }
        $tmp = $path . '.' . getmypid() . '.' . bin2hex(random_bytes(4)) . '.tmp';
        $fh = @fopen($tmp, 'xb');
        if ($fh === false) {
            throw new \RuntimeException('cannot write ' . $tmp);
        }
        $ok = fwrite($fh, $data) === strlen($data) && fflush($fh) && (!function_exists('fsync') || fsync($fh));
        fclose($fh);
        if (!$ok || !@rename($tmp, $path)) {
            @unlink($tmp);
            throw new \RuntimeException('cannot write ' . $path);
        }
    }
}
