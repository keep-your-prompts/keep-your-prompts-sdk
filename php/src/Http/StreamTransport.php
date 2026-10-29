<?php

declare(strict_types=1);

namespace KeepYourPrompts\Http;

use KeepYourPrompts\Exception\TransportException;

/**
 * Transport on PHP's http:// stream wrapper, for installs without ext-curl.
 * Uses HTTPS_PROXY/HTTP_PROXY when set (CONNECT tunnel for https).
 */
final class StreamTransport implements Transport
{
    public function get(string $url, array $headers, float $connectTimeout, float $timeout): Response
    {
        $lines = ['Connection: close', 'Accept-Encoding: identity'];
        foreach ($headers as $k => $v) {
            $lines[] = $k . ': ' . $v;
        }
        $http = [
            'method' => 'GET',
            'header' => implode("\r\n", $lines),
            'timeout' => $timeout,
            'ignore_errors' => true,
            'follow_location' => 1,
            'max_redirects' => 3,
            'protocol_version' => 1.1,
        ];
        $proxy = self::proxyFor($url);
        if ($proxy !== null) {
            $http['proxy'] = $proxy;
            $http['request_fulluri'] = str_starts_with(strtolower($url), 'http://');
        }
        $context = stream_context_create(['http' => $http]);
        $error = '';
        set_error_handler(static function (int $no, string $msg) use (&$error): bool {
            $error = $msg;

            return true;
        });
        try {
            $stream = fopen($url, 'rb', false, $context);
        } finally {
            restore_error_handler();
        }
        if ($stream === false) {
            throw new TransportException($error !== '' ? preg_replace('/^fopen\([^)]*\): /', '', $error) ?? $error : 'request failed');
        }
        $body = stream_get_contents($stream);
        $meta = stream_get_meta_data($stream);
        fclose($stream);
        if ($body === false) {
            throw new TransportException('read failed');
        }
        $status = 0;
        $responseHeaders = [];
        $raw = $meta['wrapper_data'] ?? [];
        foreach (is_array($raw) ? $raw : [] as $line) {
            if (!is_string($line)) {
                continue;
            }
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m) === 1) {
                $status = (int) $m[1];
                $responseHeaders = [];
            } elseif (($pos = strpos($line, ':')) !== false) {
                $responseHeaders[strtolower(trim(substr($line, 0, $pos)))] = trim(substr($line, $pos + 1));
            }
        }
        if ($status === 0) {
            throw new TransportException('no HTTP status received');
        }

        return new Response($status, $body, $responseHeaders);
    }

    private static function proxyFor(string $url): ?string
    {
        $host = strtolower((string) parse_url($url, PHP_URL_HOST));
        $noProxy = getenv('NO_PROXY') ?: getenv('no_proxy') ?: '';
        foreach (explode(',', $noProxy) as $entry) {
            $entry = strtolower(trim($entry));
            if ($entry !== '' && ($entry === '*' || $host === ltrim($entry, '.') || str_ends_with($host, '.' . ltrim($entry, '.')))) {
                return null;
            }
        }
        $https = str_starts_with(strtolower($url), 'https://');
        $proxy = $https ? (getenv('HTTPS_PROXY') ?: getenv('https_proxy')) : (getenv('HTTP_PROXY') ?: getenv('http_proxy'));
        if (!is_string($proxy) || $proxy === '') {
            return null;
        }
        $p = parse_url($proxy);
        if (!is_array($p) || !isset($p['host'])) {
            return null;
        }

        return 'tcp://' . $p['host'] . ':' . ($p['port'] ?? 80);
    }
}
