<?php

declare(strict_types=1);

namespace KeepYourPrompts;

/**
 * A deployed prompt: immutable, content-addressed by its sha256.
 */
final class Prompt
{
    /**
     * @param list<string> $variables
     */
    public function __construct(
        public readonly string $name,
        public readonly int $version,
        public readonly string $sha256,
        public readonly array $variables,
        public readonly string $text,
    ) {
    }

    /**
     * @param array<string, string|int|float|bool|\Stringable|null> $vars
     */
    public function render(array $vars = [], OnMissing $onMissing = OnMissing::Error): string
    {
        return Template::render($this->text, $vars, $onMissing);
    }

    public function __toString(): string
    {
        return $this->text;
    }
}
