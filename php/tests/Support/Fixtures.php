<?php

declare(strict_types=1);

namespace KeepYourPrompts\Tests\Support;

final class Fixtures
{
    public static function conformanceDir(): string
    {
        $env = getenv('KYP_CONFORMANCE_DIR');

        return is_string($env) && $env !== '' ? $env : dirname(__DIR__, 3) . '/conformance';
    }

    public static function dir(string $name): string
    {
        return self::conformanceDir() . '/fixtures/' . $name;
    }

    /**
     * @return array<string, mixed>
     */
    public static function cases(): array
    {
        $json = file_get_contents(self::conformanceDir() . '/cases.json');
        $cases = json_decode((string) $json, true, 64, JSON_THROW_ON_ERROR);
        if (!is_array($cases)) {
            throw new \RuntimeException('cases.json is not an object');
        }

        /** @var array<string, mixed> $cases */
        return $cases;
    }

    public static function tempDir(): string
    {
        $dir = sys_get_temp_dir() . '/kyp-php-test-' . bin2hex(random_bytes(6));
        mkdir($dir, 0777, true);

        return $dir;
    }

    /**
     * Deploy like the server does: blobs first, then the manifest by rename.
     */
    public static function deploy(string $fixture, string $dest): void
    {
        $src = self::dir($fixture);
        @mkdir($dest . '/blobs', 0777, true);
        @mkdir($dest . '/envs/demo', 0777, true);
        foreach (glob($src . '/blobs/*') ?: [] as $blob) {
            copy($blob, $dest . '/blobs/' . basename($blob));
        }
        copy($src . '/envs/demo/prod.json', $dest . '/envs/demo/prod.json.new');
        rename($dest . '/envs/demo/prod.json.new', $dest . '/envs/demo/prod.json');
    }

    public static function remove(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($it as $f) {
            if ($f instanceof \SplFileInfo) {
                $f->isDir() && !$f->isLink() ? rmdir($f->getPathname()) : unlink($f->getPathname());
            }
        }
        rmdir($dir);
    }
}
