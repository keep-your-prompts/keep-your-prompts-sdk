<?php

declare(strict_types=1);

namespace KeepYourPrompts;

final class ManifestPrompt
{
    /**
     * @param list<string> $variables
     */
    public function __construct(
        public readonly string $sha256,
        public readonly int $version,
        public readonly array $variables,
    ) {
    }
}
