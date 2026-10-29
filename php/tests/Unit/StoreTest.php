<?php

declare(strict_types=1);

namespace KeepYourPrompts\Tests\Unit;

use KeepYourPrompts\Internal\State;
use KeepYourPrompts\Prompt;
use KeepYourPrompts\Store\ApcuStore;
use KeepYourPrompts\Store\FileStore;
use KeepYourPrompts\Store\MemoryStore;
use KeepYourPrompts\Store\StateStore;
use KeepYourPrompts\Tests\Support\Fixtures;
use PHPUnit\Framework\TestCase;

final class StoreTest extends TestCase
{
    private string $dir = '';

    protected function setUp(): void
    {
        $this->dir = Fixtures::tempDir();
    }

    protected function tearDown(): void
    {
        Fixtures::remove($this->dir);
    }

    public function testFileStoreRoundTripAndLock(): void
    {
        $a = new FileStore($this->dir . '/nested');
        $this->roundTrip($a);
        $b = new FileStore($this->dir . '/nested');
        self::assertTrue($a->lock('k', 5));
        self::assertFalse($a->lock('k', 5), 'not re-entrant');
        self::assertFalse($b->lock('k', 5), 'held by another handle');
        $a->unlock('k');
        self::assertTrue($b->lock('k', 5));
        $b->unlock('k');
        self::assertSame([], glob($this->dir . '/nested/*.tmp'));
    }

    public function testCorruptOrForeignDataIsIgnored(): void
    {
        $s = new FileStore($this->dir);
        file_put_contents($this->dir . '/kyp-php-state-k', 'garbage');
        self::assertNull($s->load('k'));
        file_put_contents($this->dir . '/kyp-php-state-k', serialize(new \ArrayObject()));
        self::assertNull($s->load('k'));
        self::assertNull($s->load('missing'));
    }

    public function testMemoryStore(): void
    {
        $m = new MemoryStore();
        $this->roundTrip($m);
        self::assertTrue($m->lock('k', 1));
        self::assertFalse($m->lock('k', 1));
        $m->unlock('k');
        self::assertTrue($m->lock('k', 1));
    }

    public function testApcuStore(): void
    {
        if (!ApcuStore::available()) {
            self::markTestSkipped('APCu is not enabled (apc.enable_cli=1)');
        }
        $a = new ApcuStore();
        $this->roundTrip($a);
        self::assertTrue($a->lock('k', 5));
        self::assertFalse($a->lock('k', 5));
        $a->unlock('k');
    }

    private function roundTrip(StateStore $store): void
    {
        $s = new State(1000.0);
        $s->ready = true;
        $s->revision = 7;
        $s->prompts = ['p' => new Prompt('p', 2, str_repeat('a', 64), ['x'], 'body {{x}}')];
        $s->health('cdn')->failures = 3;
        $store->save('k', $s);
        $back = $store->load('k');
        self::assertNotNull($back);
        self::assertSame(7, $back->revision);
        self::assertSame('body {{x}}', $back->prompts['p']->text);
        self::assertSame(3, $back->health('cdn')->failures);
        self::assertSame(1000.0, $back->createdAt);
    }
}
