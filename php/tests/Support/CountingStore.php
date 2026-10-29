<?php

declare(strict_types=1);

namespace KeepYourPrompts\Tests\Support;

use KeepYourPrompts\Internal\State;
use KeepYourPrompts\Store\StateStore;

final class CountingStore implements StateStore
{
    public int $loads = 0;
    public int $saves = 0;

    public function __construct(private readonly StateStore $inner)
    {
    }

    public function name(): string
    {
        return $this->inner->name();
    }

    public function load(string $key): ?State
    {
        $this->loads++;

        return $this->inner->load($key);
    }

    public function save(string $key, State $state): void
    {
        $this->saves++;
        $this->inner->save($key, $state);
    }

    public function lock(string $key, float $ttl): bool
    {
        return $this->inner->lock($key, $ttl);
    }

    public function unlock(string $key): void
    {
        $this->inner->unlock($key);
    }
}
