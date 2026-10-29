<?php

declare(strict_types=1);

namespace KeepYourPrompts\Internal;

use KeepYourPrompts\Prompt;

/**
 * Everything one app env needs between requests. Shared through a StateStore by every
 * process that uses the same configuration; serialized as a whole.
 *
 * @internal
 */
final class State
{
    public const FORMAT = 1;

    public int $format = self::FORMAT;
    public bool $ready = false;
    public int $revision = 0;
    public string $workspace = '';
    public string $deployedAt = '';
    public string $rawManifest = '';
    /** @var array<string, Prompt> */
    public array $prompts = [];
    /** Mirror that served or last confirmed the current state. */
    public string $source = '';
    /** @var array<string, string> ETag of the manifest per mirror name */
    public array $etags = [];
    public float $createdAt;
    /** Last revalidation attempt (successful or not); drives the poll interval. */
    public float $checkedAt = 0.0;
    public ?float $lastSuccess = null;
    public string $lastError = '';
    /** @var array<string, MirrorHealth> */
    public array $health = [];

    public function __construct(?float $now = null)
    {
        $this->createdAt = $now ?? microtime(true);
    }

    public function __clone()
    {
        foreach ($this->health as $name => $h) {
            $this->health[$name] = clone $h;
        }
    }

    public function health(string $mirror): MirrorHealth
    {
        return $this->health[$mirror] ??= new MirrorHealth();
    }

    /**
     * @return array<string, string> sha256 => text
     */
    public function bySha(): array
    {
        $out = [];
        foreach ($this->prompts as $p) {
            $out[$p->sha256] = $p->text;
        }

        return $out;
    }

    public static function decode(string $data): ?self
    {
        $v = @unserialize($data, ['allowed_classes' => [self::class, MirrorHealth::class, Prompt::class]]);

        return $v instanceof self && $v->format === self::FORMAT ? $v : null;
    }
}
