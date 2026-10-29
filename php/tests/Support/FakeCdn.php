<?php

declare(strict_types=1);

namespace KeepYourPrompts\Tests\Support;

use PHPUnit\Framework\SkippedWithMessageException;

/**
 * Runs conformance/fake_cdn.py (Python 3, standard library only) for the duration of a test.
 */
final class FakeCdn
{
    /** @var resource */
    private $proc;
    public readonly int $port;

    /**
     * @param array<string, array{string, string}> $routes name => [url prefix, directory]
     */
    public function __construct(array $routes)
    {
        $python = self::python();
        $cmd = [$python, Fixtures::conformanceDir() . '/fake_cdn.py'];
        foreach ($routes as $name => [$prefix, $dir]) {
            $cmd[] = '--route';
            $cmd[] = $name . ':' . $prefix . ':' . $dir;
        }
        $proc = proc_open($cmd, [1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
        if (!is_resource($proc)) {
            throw new \RuntimeException('cannot start fake_cdn.py');
        }
        $this->proc = $proc;
        $line = fgets($pipes[1]);
        if (!is_string($line) || sscanf($line, 'PORT %d', $port) !== 1 || !is_int($port)) {
            throw new \RuntimeException('fake_cdn.py did not print its port');
        }
        $this->port = $port;
    }

    public function __destruct()
    {
        proc_terminate($this->proc);
        proc_close($this->proc);
    }

    public static function python(): string
    {
        foreach (['python3', 'python'] as $bin) {
            $out = [];
            exec('command -v ' . $bin . ' 2>/dev/null', $out, $code);
            if ($code === 0 && isset($out[0]) && $out[0] !== '') {
                return $out[0];
            }
        }

        throw new SkippedWithMessageException('python3 is not installed: HTTP conformance tests need conformance/fake_cdn.py');
    }

    public function base(): string
    {
        return 'http://127.0.0.1:' . $this->port;
    }

    public function down(string $route): void
    {
        $this->ctl('/__down/' . $route);
    }

    public function up(string $route): void
    {
        $this->ctl('/__up/' . $route);
    }

    public function stat(string $route, string $key): int|string|null
    {
        $stats = json_decode($this->ctl('/__stats'), true);
        if (!is_array($stats) || !is_array($stats[$route] ?? null)) {
            return null;
        }
        $v = $stats[$route][$key] ?? null;

        return is_int($v) || is_string($v) ? $v : null;
    }

    private function ctl(string $path): string
    {
        $body = file_get_contents($this->base() . $path);
        if ($body === false) {
            throw new \RuntimeException('fake_cdn.py control request failed');
        }

        return $body;
    }
}
