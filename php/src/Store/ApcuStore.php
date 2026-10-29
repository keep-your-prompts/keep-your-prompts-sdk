<?php

declare(strict_types=1);

namespace KeepYourPrompts\Store;

use KeepYourPrompts\Internal\State;

/**
 * APCu shared memory: one copy per PHP-FPM pool (or per process under the CLI with
 * apc.enable_cli=1). Reads are a single apcu_fetch.
 */
final class ApcuStore implements StateStore
{
    public static function available(): bool
    {
        return function_exists('apcu_enabled') && apcu_enabled();
    }

    public function name(): string
    {
        return 'apcu';
    }

    public function load(string $key): ?State
    {
        $v = apcu_fetch('kyp:' . $key);

        return $v instanceof State && $v->format === State::FORMAT ? $v : null;
    }

    public function save(string $key, State $state): void
    {
        apcu_store('kyp:' . $key, $state);
    }

    public function lock(string $key, float $ttl): bool
    {
        return apcu_add('kyp:' . $key . ':lock', getmypid(), max(1, (int) ceil($ttl)));
    }

    public function unlock(string $key): void
    {
        apcu_delete('kyp:' . $key . ':lock');
    }
}
