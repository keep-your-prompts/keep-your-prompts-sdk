<?php

declare(strict_types=1);

namespace KeepYourPrompts\Exception;

/**
 * get(), prompt() or render() for a name that is not in the deployed manifest.
 */
final class NotFound extends KypException
{
    public function __construct(public readonly string $name, string $detail = '')
    {
        parent::__construct(sprintf('prompt not found: "%s"', $name) . ($detail === '' ? '' : " ({$detail})"));
    }
}
