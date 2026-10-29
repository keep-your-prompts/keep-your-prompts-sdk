<?php

declare(strict_types=1);

namespace KeepYourPrompts\Store;

use KeepYourPrompts\Internal\State;

/**
 * In-process only: for long-running workers (Octane, RoadRunner, queue workers) that
 * want no shared store, and for tests.
 */
final class MemoryStore implements StateStore
{
    /** @var array<string, string> */
    private array $data = [];
    /** @var array<string, true> */
    private array $locks = [];

    public function name(): string
    {
        return 'memory';
    }

    public function load(string $key): ?State
    {
        return isset($this->data[$key]) ? State::decode($this->data[$key]) : null;
    }

    public function save(string $key, State $state): void
    {
        $this->data[$key] = serialize($state);
    }

    public function lock(string $key, float $ttl): bool
    {
        if (isset($this->locks[$key])) {
            return false;
        }
        $this->locks[$key] = true;

        return true;
    }

    public function unlock(string $key): void
    {
        unset($this->locks[$key]);
    }
}
