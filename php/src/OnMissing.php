<?php

declare(strict_types=1);

namespace KeepYourPrompts;

/**
 * What render() does with a {{variable}} that has no value.
 */
enum OnMissing
{
    /** Throw Exception\MissingVariable listing every missing name (default). */
    case Error;
    /** Leave {{name}} in the output. */
    case Keep;
    /** Replace it with an empty string. */
    case Empty;
}
