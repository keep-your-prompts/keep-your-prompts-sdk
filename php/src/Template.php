<?php

declare(strict_types=1);

namespace KeepYourPrompts;

use KeepYourPrompts\Exception\MissingVariable;

/**
 * {{name}} templates: optional spaces inside the braces, names [A-Za-z_][A-Za-z0-9_]*,
 * "{{{{" renders a literal "{{". No logic, loops or escaping; values are not rendered again.
 */
final class Template
{
    /**
     * @param array<string, string|int|float|bool|\Stringable|null> $vars
     *
     * @throws MissingVariable
     */
    public static function render(string $template, array $vars, OnMissing $onMissing = OnMissing::Error): string
    {
        $out = '';
        $missing = [];
        self::scan(
            $template,
            static function (string $text) use (&$out): void {
                $out .= $text;
            },
            static function (string $name, string $raw) use (&$out, &$missing, $vars, $onMissing): void {
                if (array_key_exists($name, $vars) && $vars[$name] !== null) {
                    $value = $vars[$name];
                    $out .= is_bool($value) ? ($value ? 'true' : 'false') : (string) $value;
                } elseif ($onMissing === OnMissing::Keep) {
                    $out .= $raw;
                } elseif ($onMissing === OnMissing::Error && !in_array($name, $missing, true)) {
                    $missing[] = $name;
                }
            },
        );
        if ($missing !== []) {
            throw new MissingVariable($missing);
        }

        return $out;
    }

    /**
     * Distinct variable names in order of first appearance.
     *
     * @return list<string>
     */
    public static function variables(string $template): array
    {
        $names = [];
        self::scan(
            $template,
            static function (string $text): void {
            },
            static function (string $name) use (&$names): void {
                if (!in_array($name, $names, true)) {
                    $names[] = $name;
                }
            },
        );

        return $names;
    }

    /**
     * @param callable(string): void         $literal
     * @param callable(string, string): void $variable called with (name, raw "{{ name }}")
     */
    private static function scan(string $t, callable $literal, callable $variable): void
    {
        $len = strlen($t);
        $i = 0;
        $run = 0;
        while ($i < $len) {
            $open = strpos($t, '{{', $i);
            if ($open === false) {
                break;
            }
            if (substr_compare($t, '{{{{', $open, 4) === 0) {
                $literal(substr($t, $run, $open - $run) . '{{');
                $i = $run = $open + 4;
                continue;
            }
            if (preg_match('/\G\{\{[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*\}\}/', $t, $m, 0, $open) === 1) {
                $literal(substr($t, $run, $open - $run));
                $variable($m[1], $m[0]);
                $i = $run = $open + strlen($m[0]);
            } else {
                $i = $open + 2; // not a variable: keep the braces as text
            }
        }
        $literal(substr($t, $run));
    }
}
