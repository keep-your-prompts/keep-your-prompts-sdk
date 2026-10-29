<?php

declare(strict_types=1);

namespace KeepYourPrompts\Tests\Unit;

use KeepYourPrompts\Exception\ProtocolError;
use KeepYourPrompts\Manifest;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class ManifestTest extends TestCase
{
    /**
     * @return iterable<string, array{string}>
     */
    public static function invalid(): iterable
    {
        $base = ['schema' => 1, 'workspace' => 'acme', 'app' => 'demo', 'env' => 'prod', 'revision' => 1, 'prompts' => []];
        $sha = str_repeat('a', 64);
        $cases = [
            'not json' => '{',
            'array' => '[1]',
            'other app' => array_merge($base, ['app' => 'other']),
            'other env' => array_merge($base, ['env' => 'dev']),
            'negative revision' => array_merge($base, ['revision' => -1]),
            'string revision' => array_merge($base, ['revision' => '3']),
            'prompts list' => array_merge($base, ['prompts' => [['sha256' => $sha]]]),
            'leading slash' => array_merge($base, ['prompts' => ['/x' => ['sha256' => $sha]]]),
            'double slash' => array_merge($base, ['prompts' => ['a//b' => ['sha256' => $sha]]]),
            'no sha' => array_merge($base, ['prompts' => ['p' => ['version' => 1]]]),
            'bad workspace' => array_merge($base, ['workspace' => '../x']),
            'missing workspace' => array_diff_key($base, ['workspace' => 1]),
        ];
        foreach ($cases as $name => $case) {
            yield $name => [is_string($case) ? $case : (string) json_encode($case)];
        }
    }

    #[DataProvider('invalid')]
    public function testRejects(string $json): void
    {
        $this->expectException(ProtocolError::class);
        Manifest::parse($json, 'demo', 'prod');
    }

    public function testUppercaseShaIsNormalisedAndSchemaIsOptional(): void
    {
        $m = Manifest::parse((string) json_encode([
            'workspace' => 'acme', 'app' => 'demo', 'env' => 'prod', 'revision' => 0,
            'prompts' => ['b/c' => ['sha256' => str_repeat('A', 64), 'variables' => ['x', 3]], 'a' => ['sha256' => str_repeat('b', 64)]],
        ]));
        self::assertSame(['a', 'b/c'], array_keys($m->prompts));
        self::assertSame(str_repeat('a', 64), $m->prompts['b/c']->sha256);
        self::assertSame(['x'], $m->prompts['b/c']->variables);
        self::assertSame(0, $m->prompts['a']->version);
        self::assertSame('', $m->deployedAt);
    }

    public function testSlugs(): void
    {
        self::assertTrue(Manifest::isSlug('support-bot'));
        self::assertFalse(Manifest::isSlug('-x'));
        self::assertFalse(Manifest::isSlug('Upper'));
        self::assertFalse(Manifest::isSlug(str_repeat('a', 64)));
        self::assertFalse(Manifest::isSlug("a\n"));
    }
}
