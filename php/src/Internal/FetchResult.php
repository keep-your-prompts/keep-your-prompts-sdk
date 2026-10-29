<?php

declare(strict_types=1);

namespace KeepYourPrompts\Internal;

/**
 * @internal
 */
final class FetchResult
{
    public const OK = 'ok';
    public const NOT_MODIFIED = 'not_modified';
    public const NOT_FOUND = 'not_found';
    public const FAILED = 'failed';

    /**
     * @param self::OK|self::NOT_MODIFIED|self::NOT_FOUND|self::FAILED $kind
     */
    public function __construct(
        public readonly string $kind,
        public readonly string $body = '',
        public readonly string $etag = '',
        public readonly string $error = '',
    ) {
    }

    public static function ok(string $body, string $etag = ''): self
    {
        return new self(self::OK, $body, $etag);
    }

    public static function notFound(string $error): self
    {
        return new self(self::NOT_FOUND, error: $error);
    }

    public static function failed(string $error): self
    {
        return new self(self::FAILED, error: $error);
    }

    public static function readFile(string $path): self
    {
        if (!is_file($path)) {
            return self::notFound('no such file');
        }
        $body = @file_get_contents($path);

        return is_string($body) ? self::ok($body) : self::failed('cannot read ' . basename($path));
    }
}
