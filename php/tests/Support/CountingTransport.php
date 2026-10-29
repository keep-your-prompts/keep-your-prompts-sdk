<?php

declare(strict_types=1);

namespace KeepYourPrompts\Tests\Support;

use KeepYourPrompts\Http\Response;
use KeepYourPrompts\Http\Transport;

final class CountingTransport implements Transport
{
    public int $calls = 0;
    /** @var list<array{string, array<string, string>}> */
    public array $requests = [];

    public function __construct(private readonly Transport $inner)
    {
    }

    public function get(string $url, array $headers, float $connectTimeout, float $timeout): Response
    {
        $this->calls++;
        $this->requests[] = [$url, $headers];

        return $this->inner->get($url, $headers, $connectTimeout, $timeout);
    }
}
