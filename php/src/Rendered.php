<?php

declare(strict_types=1);

namespace KeepYourPrompts;

/**
 * What KeepYourPrompts::renderWithMeta() returns: the rendered text and the metadata of the
 * exact body that was rendered.
 */
final class Rendered implements \Stringable
{
    public function __construct(
        public readonly string $text,
        public readonly PromptMeta $meta,
    ) {
    }

    public function __toString(): string
    {
        return $this->text;
    }
}
