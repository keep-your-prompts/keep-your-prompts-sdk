<?php

declare(strict_types=1);

namespace KeepYourPrompts\Exception;

/**
 * No mirror could deliver a manifest at start-up (see Options::$startupTimeout).
 */
final class Unavailable extends KypException
{
}
