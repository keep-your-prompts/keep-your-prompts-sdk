<?php

declare(strict_types=1);

namespace KeepYourPrompts\Http;

use KeepYourPrompts\Exception\TransportException;

/**
 * ext-curl transport. One handle per instance, reused across requests (keep-alive),
 * gzip, HTTP/2 when offered; HTTPS_PROXY / NO_PROXY are honoured by libcurl.
 */
final class CurlTransport implements Transport
{
    private ?\CurlHandle $handle = null;

    public function get(string $url, array $headers, float $connectTimeout, float $timeout): Response
    {
        $this->handle ??= curl_init() ?: throw new TransportException('curl_init failed');
        $h = $this->handle;
        curl_reset($h);
        $responseHeaders = [];
        $lines = [];
        foreach ($headers as $k => $v) {
            $lines[] = $k . ': ' . $v;
        }
        curl_setopt_array($h, [
            CURLOPT_URL => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $lines,
            CURLOPT_ENCODING => '',
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 3,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_CONNECTTIMEOUT_MS => (int) ceil($connectTimeout * 1000),
            CURLOPT_TIMEOUT_MS => (int) ceil($timeout * 1000),
            CURLOPT_NOSIGNAL => true,
            CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$responseHeaders): int {
                $pos = strpos($line, ':');
                if ($pos !== false) {
                    $responseHeaders[strtolower(trim(substr($line, 0, $pos)))] = trim(substr($line, $pos + 1));
                } elseif (str_starts_with($line, 'HTTP/')) {
                    $responseHeaders = []; // a new response after a redirect
                }

                return strlen($line);
            },
        ]);
        $body = curl_exec($h);
        if (!is_string($body)) {
            throw new TransportException(curl_error($h) !== '' ? curl_error($h) : 'request failed');
        }

        return new Response((int) curl_getinfo($h, CURLINFO_RESPONSE_CODE), $body, $responseHeaders);
    }
}
