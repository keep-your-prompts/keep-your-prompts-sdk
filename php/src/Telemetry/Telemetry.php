<?php

declare(strict_types=1);

namespace KeepYourPrompts\Telemetry;

/**
 * Helpers shared by the client and the OpenTelemetry add-on.
 */
final class Telemetry
{
    private const SOURCES = ['embedded', 'snapshot', 'cache', 'cdn', 'origin', 'git'];

    private function __construct()
    {
    }

    /**
     * A mirror's configured name and kind ('file', 'cache', 'http', 'embedded') to kyp.source.
     */
    public static function normalizeSource(string $name, string $kind): string
    {
        if ($name === '') {
            return '';
        }
        if ($name === 'disk-cache') {
            return 'cache';
        }
        if (in_array($name, self::SOURCES, true)) {
            return $name;
        }

        return match ($kind) {
            'embedded' => 'embedded',
            'cache' => 'cache',
            'file' => 'snapshot',
            default => 'custom',
        };
    }

    /**
     * A failure message to a low-cardinality error.type.
     */
    public static function classifyError(string $message): string
    {
        $m = strtolower($message);

        return match (true) {
            (bool) preg_match('/blob \S+ unavailable/', $m) => 'blob_unavailable',
            str_contains($m, 'sha256 verification') || str_contains($m, 'hash mismatch') => 'hash_mismatch',
            str_contains($m, 'stale manifest') => 'stale',
            str_contains($m, 'bad manifest') || str_contains($m, 'invalid manifest') => 'bad_manifest',
            (bool) preg_match('/http (404|410)\b/', $m) || str_contains($m, 'not found') || str_contains($m, 'no such file') => 'not_found',
            (bool) preg_match('/http (\d{3})\b/', $m, $g) => 'http_' . $g[1],
            (bool) preg_match('/timed out|timeout|deadline/', $m) => 'timeout',
            (bool) preg_match('/refused|reset|resolve|unreachable|network|socket|connect|ssl|tls/', $m) => 'network',
            default => '_OTHER',
        };
    }
}
