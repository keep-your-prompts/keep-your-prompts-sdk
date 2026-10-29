<?php

declare(strict_types=1);

namespace KeepYourPrompts;

final class MirrorStatus
{
    public function __construct(
        public readonly string $name,
        /** Delivery key redacted. */
        public readonly string $url,
        public readonly int $consecutiveFailures,
        public readonly string $lastError,
        public readonly ?\DateTimeImmutable $lastSuccess,
    ) {
    }
}
