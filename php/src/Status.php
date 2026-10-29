<?php

declare(strict_types=1);

namespace KeepYourPrompts;

/**
 * Health of the client, for logs, metrics and health checks.
 */
final class Status
{
    /**
     * @param list<MirrorStatus> $mirrors
     */
    public function __construct(
        /** A manifest is loaded. */
        public readonly bool $ready,
        /** Mirror that served or last confirmed the current state: snapshot, disk-cache, cdn, origin, git. */
        public readonly string $source,
        public readonly int $revision,
        public readonly string $workspace,
        public readonly string $deployedAt,
        public readonly int $promptCount,
        /** Last time a polled mirror confirmed the manifest (200 or 304). */
        public readonly ?\DateTimeImmutable $lastSuccess,
        /** Last revalidation attempt by any process sharing the store. */
        public readonly ?\DateTimeImmutable $lastCheck,
        /** Failures in the latest round, e.g. "cdn: HTTP 503". Empty when the first mirror answered. */
        public readonly string $lastError,
        /** Seconds since freshness was last confirmed (since the state was created if never). Alert on this. */
        public readonly float $staleFor,
        /** Where the state is shared: apcu, file or memory. */
        public readonly string $store,
        public readonly array $mirrors,
    ) {
    }

    /**
     * @return array<string, mixed> JSON-friendly, for health endpoints
     */
    public function toArray(): array
    {
        $date = static fn (?\DateTimeImmutable $d): ?string => $d?->format(\DateTimeInterface::RFC3339_EXTENDED);

        return [
            'ready' => $this->ready,
            'source' => $this->source,
            'revision' => $this->revision,
            'workspace' => $this->workspace,
            'deployed_at' => $this->deployedAt,
            'prompt_count' => $this->promptCount,
            'last_success' => $date($this->lastSuccess),
            'last_check' => $date($this->lastCheck),
            'last_error' => $this->lastError,
            'stale_for' => round($this->staleFor, 3),
            'store' => $this->store,
            'mirrors' => array_map(static fn (MirrorStatus $m): array => [
                'name' => $m->name,
                'url' => $m->url,
                'consecutive_failures' => $m->consecutiveFailures,
                'last_error' => $m->lastError,
                'last_success' => $date($m->lastSuccess),
            ], $this->mirrors),
        ];
    }
}
