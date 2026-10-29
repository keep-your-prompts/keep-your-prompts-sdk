<?php

declare(strict_types=1);

namespace KeepYourPrompts\Http;

final class Response
{
    /**
     * @param array<string, string> $headers lowercase names
     */
    public function __construct(
        public readonly int $status,
        public readonly string $body,
        public readonly array $headers = [],
    ) {
    }

    public function header(string $name): string
    {
        return $this->headers[strtolower($name)] ?? '';
    }
}
