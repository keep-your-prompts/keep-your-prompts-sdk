<?php

declare(strict_types=1);

namespace KeepYourPrompts\Internal;

use KeepYourPrompts\Manifest;
use KeepYourPrompts\Prompt;

/**
 * Result of asking one mirror for the manifest.
 *
 * @internal
 */
final class Attempt
{
    public const UPDATED = 'updated';
    public const UNCHANGED = 'unchanged';
    public const STALE = 'stale';
    public const FAILED = 'failed';

    /**
     * @param self::UPDATED|self::UNCHANGED|self::STALE|self::FAILED $outcome
     * @param array<string, Prompt>                                  $prompts
     */
    public function __construct(
        public readonly string $outcome,
        public readonly ?Manifest $manifest = null,
        public readonly string $raw = '',
        public readonly array $prompts = [],
        public readonly string $etag = '',
        public readonly string $error = '',
        public readonly bool $missing = false,
    ) {
    }
}
