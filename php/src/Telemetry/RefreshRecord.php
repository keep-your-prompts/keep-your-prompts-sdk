<?php

declare(strict_types=1);

namespace KeepYourPrompts\Telemetry;

/**
 * One refresh round, passed to Observer::onRefresh().
 */
final class RefreshRecord
{
    /**
     * @param 'start'|'poll'|'manual'               $trigger
     * @param 'updated'|'not_modified'|'failed'     $result
     * @param float                                 $startTime wall clock, seconds since the epoch
     * @param float                                 $duration  seconds
     * @param string                                $mirror    configured name of the mirror that answered ('' when failed)
     * @param string                                $source    its normalised kind ('' when failed)
     * @param string                                $error     when failed: short message, delivery key redacted
     * @param string                                $errorType when failed: low-cardinality error.type
     * @param list<TelemetryEvent>                  $events
     */
    public function __construct(
        public readonly string $app,
        public readonly string $env,
        public readonly string $trigger,
        public readonly string $result,
        public readonly float $startTime,
        public readonly float $duration,
        public readonly string $mirror,
        public readonly string $source,
        public readonly int $revision,
        public readonly int $previousRevision,
        public readonly string $workspace,
        public readonly string $error,
        public readonly string $errorType,
        public readonly array $events,
    ) {
    }
}
