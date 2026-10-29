<?php

declare(strict_types=1);

namespace KeepYourPrompts;

/**
 * One copy of a workspace in the protocol layout (envs/<app>/<env>.json, blobs/<sha256>).
 */
final class Mirror
{
    public function __construct(
        /** Shown in status() and logs, e.g. "cdn". */
        public readonly string $name,
        /** A directory, file:///dir, or http(s)://host/base. */
        public readonly string $url,
        /** Sent as Authorization: Bearer (git mirror, origin with header auth). */
        public readonly string $bearerToken = '',
    ) {
    }

    public static function file(string $dir, string $name = 'snapshot'): self
    {
        return new self($name, $dir);
    }

    public static function http(string $baseUrl, string $name, string $bearerToken = ''): self
    {
        return new self($name, $baseUrl, $bearerToken);
    }

    public function isHttp(): bool
    {
        $u = strtolower($this->url);

        return str_starts_with($u, 'http://') || str_starts_with($u, 'https://');
    }

    /** Local directory of a file mirror. */
    public function path(): string
    {
        return str_starts_with($this->url, 'file://') ? rawurldecode(substr($this->url, 7)) : $this->url;
    }
}
