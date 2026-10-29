<?php

declare(strict_types=1);

namespace KeepYourPrompts;

use KeepYourPrompts\Exception\KypException;

/**
 * Client configuration. Only $app is required; everything else has a default.
 *
 *     new Options(app: 'support-bot', deliveryKey: getenv('KYP_DELIVERY_KEY'));
 */
final class Options
{
    public const VERSION = '0.1.0';
    public const DEFAULT_CDN = 'https://cdn.keepyourprompts.com/v1/d';
    public const DEFAULT_ORIGIN = 'https://api.keepyourprompts.com/v1/delivery';

    public const LOG_LEVELS = ['debug' => 0, 'info' => 1, 'warn' => 2, 'error' => 3, 'off' => 4];

    /**
     * @param list<Mirror>|null                    $mirrors replaces the snapshot/CDN/origin/git defaults (the disk cache still applies)
     * @param 'auto'|'apcu'|'file'|'memory'        $store   where request-spanning state lives
     * @param \Closure(string, string): void|null  $logger  called with (level, message); default error_log()
     * @param 'debug'|'info'|'warn'|'error'|'off'  $logLevel
     */
    public function __construct(
        public readonly string $app,
        public readonly string $env = 'prod',
        public readonly ?string $deliveryKey = null,
        public readonly ?string $workspace = null,
        public readonly ?string $snapshotDir = null,
        public readonly ?string $cacheDir = null,
        public readonly ?string $gitMirror = null,
        public readonly ?string $gitToken = null,
        public readonly string $cdnBase = self::DEFAULT_CDN,
        public readonly string $originBase = self::DEFAULT_ORIGIN,
        public readonly ?array $mirrors = null,
        /** Seconds between manifest revalidations, shared by every process using the same store. */
        public readonly float $pollInterval = 30.0,
        public readonly float $connectTimeout = 2.0,
        public readonly float $requestTimeout = 5.0,
        /** How long the very first load may block on the network when nothing local exists. */
        public readonly float $startupTimeout = 3.0,
        public readonly float $maxBackoff = 300.0,
        /** Start with no prompts instead of throwing Exception\Unavailable. */
        public readonly bool $startEmpty = false,
        public readonly string $store = 'auto',
        /** Directory of the file store (default: $cacheDir, else sys_get_temp_dir()/keepyourprompts). */
        public readonly ?string $stateDir = null,
        /** Revalidate from get() when the poll interval has passed. Off: only refresh() touches the network. */
        public readonly bool $autoRefresh = true,
        /** Run due revalidations at shutdown (after fastcgi_finish_request() under PHP-FPM) instead of inline. */
        public readonly bool $refreshOnShutdown = false,
        public readonly string $userAgent = 'kyp-php/' . self::VERSION,
        public readonly ?\Closure $logger = null,
        public readonly string $logLevel = 'warn',
    ) {
        if (!Manifest::isSlug($app)) {
            throw new KypException(sprintf('kyp: app must be a slug like "support-bot" (got "%s"); set KYP_APP', $app));
        }
        if (!Manifest::isSlug($env)) {
            throw new KypException(sprintf('kyp: env must be a slug like "prod" (got "%s")', $env));
        }
        if (!in_array($store, ['auto', 'apcu', 'file', 'memory'], true)) {
            throw new KypException(sprintf('kyp: store must be auto, apcu, file or memory (got "%s")', $store));
        }
        if (!array_key_exists($logLevel, self::LOG_LEVELS)) {
            throw new KypException(sprintf('kyp: log level must be debug, info, warn, error or off (got "%s")', $logLevel));
        }
        if ($pollInterval < 0 || $connectTimeout <= 0 || $requestTimeout <= 0 || $startupTimeout < 0 || $maxBackoff < 0) {
            throw new KypException('kyp: intervals and timeouts must be positive');
        }
    }

    /**
     * KYP_APP, KYP_ENV, KYP_DELIVERY_KEY, KYP_WORKSPACE, KYP_SNAPSHOT_DIR, KYP_CACHE_DIR,
     * KYP_GIT_MIRROR, KYP_GIT_TOKEN, KYP_CDN_URL, KYP_ORIGIN_URL, KYP_POLL_INTERVAL (seconds),
     * KYP_STORE (auto|apcu|file|memory), KYP_LOG (debug|info|warn|error|off).
     *
     * @param array<string, mixed> $overrides snake_case keys as in fromArray(), applied on top
     */
    public static function fromEnv(array $overrides = []): self
    {
        $map = [
            'KYP_APP' => 'app', 'KYP_ENV' => 'env', 'KYP_DELIVERY_KEY' => 'delivery_key',
            'KYP_WORKSPACE' => 'workspace', 'KYP_SNAPSHOT_DIR' => 'snapshot_dir', 'KYP_CACHE_DIR' => 'cache_dir',
            'KYP_GIT_MIRROR' => 'git_mirror', 'KYP_GIT_TOKEN' => 'git_token', 'KYP_CDN_URL' => 'cdn_url',
            'KYP_ORIGIN_URL' => 'origin_url', 'KYP_POLL_INTERVAL' => 'poll_interval', 'KYP_STORE' => 'store',
            'KYP_LOG' => 'log_level',
        ];
        $config = [];
        foreach ($map as $var => $key) {
            $value = self::env($var);
            if ($value !== null) {
                $config[$key] = $value;
            }
        }

        return self::fromArray(array_merge($config, array_filter($overrides, static fn ($v): bool => $v !== null)));
    }

    /**
     * Build from a config array (snake_case keys, e.g. Laravel's config/keepyourprompts.php).
     * Empty strings count as unset.
     *
     * @param array<string, mixed> $c
     */
    public static function fromArray(array $c): self
    {
        $str = static function (string $key) use ($c): ?string {
            $v = $c[$key] ?? null;
            if ($v === null || $v === '') {
                return null;
            }
            if (!is_scalar($v)) {
                throw new KypException(sprintf('kyp: option "%s" must be a string', $key));
            }

            return (string) $v;
        };
        $num = static function (string $key, float $default) use ($c): float {
            $v = $c[$key] ?? null;
            if ($v === null || $v === '') {
                return $default;
            }
            if (!is_numeric($v)) {
                throw new KypException(sprintf('kyp: option "%s" must be a number of seconds', $key));
            }

            return (float) $v;
        };
        $bool = static function (string $key, bool $default) use ($c): bool {
            $v = $c[$key] ?? null;
            if ($v === null || $v === '') {
                return $default;
            }

            return filter_var($v, FILTER_VALIDATE_BOOLEAN);
        };
        $mirrors = null;
        if (isset($c['mirrors']) && is_array($c['mirrors'])) {
            $mirrors = [];
            foreach ($c['mirrors'] as $m) {
                if ($m instanceof Mirror) {
                    $mirrors[] = $m;
                } elseif (is_array($m) && is_string($m['name'] ?? null) && is_string($m['url'] ?? null)) {
                    $token = $m['token'] ?? '';
                    $mirrors[] = new Mirror($m['name'], $m['url'], is_string($token) ? $token : '');
                } else {
                    throw new KypException('kyp: each mirror needs a "name" and a "url"');
                }
            }
        }
        $logger = $c['logger'] ?? null;
        $store = $str('store') ?? 'auto';
        $logLevel = $str('log_level') ?? 'warn';
        if (!in_array($store, ['auto', 'apcu', 'file', 'memory'], true)) {
            throw new KypException(sprintf('kyp: store must be auto, apcu, file or memory (got "%s")', $store));
        }
        if (!in_array($logLevel, ['debug', 'info', 'warn', 'error', 'off'], true)) {
            throw new KypException(sprintf('kyp: log level must be debug, info, warn, error or off (got "%s")', $logLevel));
        }

        return new self(
            app: $str('app') ?? '',
            env: $str('env') ?? 'prod',
            deliveryKey: $str('delivery_key'),
            workspace: $str('workspace'),
            snapshotDir: $str('snapshot_dir'),
            cacheDir: $str('cache_dir'),
            gitMirror: $str('git_mirror'),
            gitToken: $str('git_token'),
            cdnBase: $str('cdn_url') ?? self::DEFAULT_CDN,
            originBase: $str('origin_url') ?? self::DEFAULT_ORIGIN,
            mirrors: $mirrors,
            pollInterval: $num('poll_interval', 30.0),
            connectTimeout: $num('connect_timeout', 2.0),
            requestTimeout: $num('request_timeout', 5.0),
            startupTimeout: $num('startup_timeout', 3.0),
            maxBackoff: $num('max_backoff', 300.0),
            startEmpty: $bool('start_empty', false),
            store: $store,
            stateDir: $str('state_dir'),
            autoRefresh: $bool('auto_refresh', true),
            refreshOnShutdown: $bool('refresh_on_shutdown', false),
            userAgent: $str('user_agent') ?? 'kyp-php/' . self::VERSION,
            logger: $logger instanceof \Closure ? $logger : (is_callable($logger) ? \Closure::fromCallable($logger) : null),
            logLevel: $logLevel,
        );
    }

    private static function env(string $name): ?string
    {
        $v = $_ENV[$name] ?? $_SERVER[$name] ?? getenv($name);

        return is_string($v) && $v !== '' ? $v : null;
    }
}
