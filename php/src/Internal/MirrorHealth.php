<?php

declare(strict_types=1);

namespace KeepYourPrompts\Internal;

/**
 * @internal
 */
final class MirrorHealth
{
    public int $failures = 0;
    public string $lastError = '';
    public ?float $lastSuccess = null;
    /** Skip this mirror in scheduled rounds until then (unix seconds). */
    public float $retryAt = 0.0;
}
