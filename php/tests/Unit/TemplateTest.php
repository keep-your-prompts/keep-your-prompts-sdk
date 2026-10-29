<?php

declare(strict_types=1);

namespace KeepYourPrompts\Tests\Unit;

use KeepYourPrompts\Exception\MissingVariable;
use KeepYourPrompts\OnMissing;
use KeepYourPrompts\Prompt;
use KeepYourPrompts\Template;
use PHPUnit\Framework\TestCase;

final class TemplateTest extends TestCase
{
    public function testListsEveryMissingVariableOnce(): void
    {
        try {
            Template::render('{{a}} {{b}} {{a}}', []);
            self::fail('expected MissingVariable');
        } catch (MissingVariable $e) {
            self::assertSame(['a', 'b'], $e->names);
            self::assertSame('missing template variables: a, b', $e->getMessage());
        }
    }

    public function testEmptyModeAndValueTypes(): void
    {
        self::assertSame('[] [x]', Template::render('[{{a}}] [{{b}}]', ['b' => 'x'], OnMissing::Empty));
        $stringable = new class () implements \Stringable {
            public function __toString(): string
            {
                return 'S';
            }
        };
        self::assertSame('1 2.5 true S', Template::render('{{i}} {{f}} {{b}} {{s}}', ['i' => 1, 'f' => 2.5, 'b' => true, 's' => $stringable]));
        self::assertSame('{{a}}', Template::render('{{a}}', ['a' => null], OnMissing::Keep), 'null counts as missing');
    }

    public function testEdgeCases(): void
    {
        self::assertSame('{{{x}}', Template::render('{{{x}}', ['x' => 'y']), 'same scan as the other SDKs');
        self::assertSame('{{', Template::render('{{', []));
        self::assertSame('a}}b', Template::render('a}}b', []));
        self::assertSame("v\tv", Template::render("{{\tx\t}}\t{{x}}", ['x' => 'v']));
        self::assertSame(['x'], Template::variables('{{ x }}{{x}}{{{{y}}'));
        self::assertSame([], Template::variables(''));
    }

    public function testPromptRender(): void
    {
        $p = new Prompt('p', 1, str_repeat('0', 64), ['who'], 'Hi {{who}}');
        self::assertSame('Hi Ana', $p->render(['who' => 'Ana']));
        self::assertSame('Hi {{who}}', (string) $p);
    }
}
