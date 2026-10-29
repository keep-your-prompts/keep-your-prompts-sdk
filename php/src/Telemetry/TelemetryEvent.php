<?php

declare(strict_types=1);

namespace KeepYourPrompts\Telemetry;

/**
 * A span event recorded during a refresh round: kyp.fallback, kyp.hash_mismatch or kyp.update.
 */
final class TelemetryEvent
{
    /**
     * @param 'kyp.fallback'|'kyp.hash_mismatch'|'kyp.update' $name
     * @param float                                            $time       wall clock, seconds since the epoch
     * @param array<string, string|int>                        $attributes
     */
    public function __construct(
        public readonly string $name,
        public readonly float $time,
        public readonly array $attributes,
    ) {
    }
}
