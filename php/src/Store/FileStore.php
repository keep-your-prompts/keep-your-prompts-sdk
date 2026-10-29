<?php

declare(strict_types=1);

namespace KeepYourPrompts\Store;

use KeepYourPrompts\Internal\State;

/**
 * A file per app env: written to a temp file and renamed into place (readers never see
 * a partial write), locked with flock(LOCK_NB) so only one process revalidates.
 * A lock dies with its process.
 */
final class FileStore implements StateStore
{
    /** @var array<string, resource> */
    private array $locks = [];

    public function __construct(private readonly string $dir)
    {
    }

    public function name(): string
    {
        return 'file';
    }

    public function load(string $key): ?State
    {
        $data = @file_get_contents($this->path($key));

        return is_string($data) ? State::decode($data) : null;
    }

    public function save(string $key, State $state): void
    {
        $this->ensureDir();
        $path = $this->path($key);
        $tmp = $path . '.' . getmypid() . '.' . bin2hex(random_bytes(4)) . '.tmp';
        if (@file_put_contents($tmp, serialize($state)) === false || !@rename($tmp, $path)) {
            @unlink($tmp);
            throw new \RuntimeException('cannot write ' . $path);
        }
    }

    public function lock(string $key, float $ttl): bool
    {
        if (isset($this->locks[$key])) {
            return false;
        }
        $this->ensureDir();
        $fh = @fopen($this->path($key) . '.lock', 'c');
        if ($fh === false) {
            return false;
        }
        if (!flock($fh, LOCK_EX | LOCK_NB)) {
            fclose($fh);

            return false;
        }
        $this->locks[$key] = $fh;

        return true;
    }

    public function unlock(string $key): void
    {
        if (isset($this->locks[$key])) {
            flock($this->locks[$key], LOCK_UN);
            fclose($this->locks[$key]);
            unset($this->locks[$key]);
        }
    }

    private function path(string $key): string
    {
        return $this->dir . DIRECTORY_SEPARATOR . 'kyp-php-state-' . $key;
    }

    private function ensureDir(): void
    {
        if (!is_dir($this->dir) && !@mkdir($this->dir, 0775, true) && !is_dir($this->dir)) {
            throw new \RuntimeException('cannot create ' . $this->dir);
        }
    }
}
