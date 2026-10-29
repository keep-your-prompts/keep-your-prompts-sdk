<?php

declare(strict_types=1);

namespace KeepYourPrompts;

/**
 * Passed to the onUpdate() callbacks after a new revision was swapped in.
 */
final class Update
{
    /**
     * @param list<string> $changed prompts added, removed or with a new body
     */
    public function __construct(
        public readonly int $oldRevision,
        public readonly int $newRevision,
        public readonly string $source,
        public readonly array $changed,
    ) {
    }
}
