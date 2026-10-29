<?php

declare(strict_types=1);

namespace KeepYourPrompts\Http;

use KeepYourPrompts\Exception\TransportException;

/**
 * Minimal HTTP GET used to talk to mirrors. Implementations must not follow
 * redirects to non-HTTP(S) schemes and must return 304s as-is.
 */
interface Transport
{
    /**
     * @param array<string, string> $headers
     *
     * @throws TransportException when no HTTP status was received
     */
    public function get(string $url, array $headers, float $connectTimeout, float $timeout): Response;
}
