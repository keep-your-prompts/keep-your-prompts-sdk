<?php

declare(strict_types=1);

namespace KeepYourPrompts\Exception;

/**
 * render() was called without a value for one or more {{variables}}.
 */
final class MissingVariable extends KypException
{
    /**
     * @param list<string> $names every missing variable, in order of first appearance
     */
    public function __construct(public readonly array $names)
    {
        parent::__construct(
            (count($names) === 1 ? 'missing template variable: ' : 'missing template variables: ') . implode(', ', $names),
        );
    }
}
