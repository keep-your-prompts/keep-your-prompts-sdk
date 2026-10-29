<?php

declare(strict_types=1);

namespace KeepYourPrompts\Store;

use KeepYourPrompts\Internal\State;

/**
 * Where the client keeps its state between requests. PHP is request-scoped, so the
 * state every request reads (manifest, prompt bodies, ETags, mirror health) lives in
 * a store shared by the processes of one server: APCu shared memory, or a file.
 */
interface StateStore
{
    /** "apcu", "file" or "memory"; shown in status(). */
    public function name(): string;

    public function load(string $key): ?State;

    public function save(string $key, State $state): void;

    /**
     * Take the refresh lock for $key without blocking. Only the holder revalidates;
     * everyone else keeps serving what is stored. Expires after $ttl seconds.
     */
    public function lock(string $key, float $ttl): bool;

    public function unlock(string $key): void;
}
