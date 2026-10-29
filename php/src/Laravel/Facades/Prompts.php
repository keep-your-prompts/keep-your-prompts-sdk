<?php

declare(strict_types=1);

namespace KeepYourPrompts\Laravel\Facades;

use Illuminate\Support\Facades\Facade;
use KeepYourPrompts\KeepYourPrompts;

/**
 * @method static string                       get(string $name)
 * @method static string|null                  tryGet(string $name)
 * @method static bool                         has(string $name)
 * @method static \KeepYourPrompts\Prompt      prompt(string $name)
 * @method static string                       render(string $name, array<string, mixed> $vars = [], \KeepYourPrompts\OnMissing $onMissing = \KeepYourPrompts\OnMissing::Error)
 * @method static list<string>                 names()
 * @method static int                          revision()
 * @method static \KeepYourPrompts\Status      status()
 * @method static bool                         refresh()
 *
 * @see KeepYourPrompts
 */
final class Prompts extends Facade
{
    protected static function getFacadeAccessor(): string
    {
        return KeepYourPrompts::class;
    }
}
