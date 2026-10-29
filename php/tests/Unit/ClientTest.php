<?php

declare(strict_types=1);

namespace KeepYourPrompts\Tests\Unit;

use KeepYourPrompts\Exception\NotFound;
use KeepYourPrompts\Exception\Unavailable;
use KeepYourPrompts\KeepYourPrompts;
use KeepYourPrompts\Options;
use KeepYourPrompts\Store\FileStore;
use KeepYourPrompts\Store\MemoryStore;
use KeepYourPrompts\Tests\Support\FakeCdn;
use KeepYourPrompts\Tests\Support\Fixtures;
use PHPUnit\Framework\TestCase;

final class ClientTest extends TestCase
{
    private const KEY = 'kypd_Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4f';

    private string $tmp = '';
    private ?FakeCdn $cdn = null;

    protected function setUp(): void
    {
        $this->tmp = Fixtures::tempDir();
    }

    protected function tearDown(): void
    {
        $this->cdn = null;
        Fixtures::remove($this->tmp);
    }

    public function testGetRevalidatesAtMostOncePerPollInterval(): void
    {
        $c = $this->client(['poll_interval' => 0.3]);
        $c->get('greeting');
        $c->get('greeting');
        self::assertSame(0, $this->cdn()->stat('cdn', '304'));
        usleep(350_000);
        $c->get('greeting');
        $c->get('greeting');
        self::assertSame(1, $this->cdn()->stat('cdn', '304'));
        self::assertNotNull($c->status()->lastCheck);
    }

    public function testAutoRefreshPicksUpDeploy(): void
    {
        $c = $this->client(['poll_interval' => 0.1]);
        self::assertSame(12, $c->revision());
        Fixtures::deploy('v13', $this->tmp . '/srv');
        usleep(150_000);
        self::assertSame(5, $c->prompt('greeting')->version);
    }

    public function testFailingMirrorBacksOff(): void
    {
        $c = $this->client(['poll_interval' => 0.1, 'max_backoff' => 10]);
        $this->cdn()->down('cdn');
        for ($round = 1; $round <= 4; $round++) {
            usleep(130_000);
            $c->get('greeting');
            self::assertSame('origin', $c->status()->source);
        }
        // Failures 1, 2, 3 were tried (0 and 1 poll intervals of backoff); the 4th round skipped the CDN.
        self::assertSame(3, $this->cdn()->stat('cdn', '503'));
        self::assertSame(3, $c->status()->mirrors[0]->consecutiveFailures);
        // refresh() ignores backoff.
        $this->cdn()->up('cdn');
        self::assertTrue($c->refresh());
        self::assertSame('cdn', $c->status()->source);
        self::assertSame(0, $c->status()->mirrors[0]->consecutiveFailures);
    }

    public function testStartEmptyThenRecover(): void
    {
        $this->cdn()->down('cdn');
        $this->cdn()->down('origin');
        $start = microtime(true);
        $c = $this->client(['start_empty' => true, 'startup_timeout' => 0.3]);
        self::assertFalse($c->status()->ready);
        self::assertLessThan(2.0, microtime(true) - $start);
        self::assertNull($c->tryGet('greeting'));
        self::assertFalse($c->has('greeting'));
        $this->cdn()->up('origin');
        self::assertTrue($c->refresh());
        self::assertSame('origin', $c->status()->source);
        self::assertTrue($c->has('greeting'));
    }

    public function testStartupWithoutAnyCopyThrows(): void
    {
        $c = new KeepYourPrompts(new Options(
            app: 'demo',
            deliveryKey: self::KEY,
            cdnBase: 'http://127.0.0.1:9/v1/d',
            originBase: 'http://127.0.0.1:9/v1/delivery',
            startupTimeout: 0.3,
            logLevel: 'off',
        ), new MemoryStore());
        $start = microtime(true);
        try {
            $c->get('greeting');
            self::fail('expected Unavailable');
        } catch (Unavailable $e) {
            self::assertStringNotContainsString(self::KEY, $e->getMessage());
        }
        self::assertLessThan(2.0, microtime(true) - $start);
        self::assertFalse($c->status()->ready);
        self::assertStringContainsString('could not load demo/prod', $c->status()->lastError);
        foreach ($c->status()->mirrors as $m) {
            self::assertStringNotContainsString(self::KEY, $m->url);
        }
        self::assertStringContainsString('kypd_Ab3d...', $c->status()->mirrors[0]->url);
    }

    public function testNothingConfiguredExplainsWhatToSet(): void
    {
        $this->expectException(Unavailable::class);
        $this->expectExceptionMessage('KYP_DELIVERY_KEY');
        (new KeepYourPrompts(new Options(app: 'demo', logLevel: 'off'), new MemoryStore()))->names();
    }

    public function testNotFound(): void
    {
        $c = new KeepYourPrompts(new Options(app: 'demo', snapshotDir: Fixtures::dir('v12'), logLevel: 'off'), new MemoryStore());
        try {
            $c->get('nope');
            self::fail('expected NotFound');
        } catch (NotFound $e) {
            self::assertSame('nope', $e->name);
            self::assertSame('prompt not found: "nope" (demo/prod revision 12)', $e->getMessage());
        }
    }

    public function testSnapshotFolderIsPolledWhenThereIsNoNetworkMirror(): void
    {
        $snap = $this->tmp . '/snap';
        Fixtures::deploy('v12', $snap);
        $updates = 0;
        $c = new KeepYourPrompts(new Options(app: 'demo', snapshotDir: $snap, logLevel: 'off'), new MemoryStore());
        $c->onUpdate(static function () use (&$updates): void {
            $updates++;
        });
        self::assertSame(12, $c->revision());
        Fixtures::deploy('v13', $snap);
        self::assertTrue($c->refresh());
        self::assertSame(13, $c->revision());
        self::assertSame(1, $updates);
    }

    public function testSharedFileStoreServesOtherClientsWithoutNetwork(): void
    {
        $store = $this->tmp . '/state';
        $a = $this->client(['store' => 'file', 'state_dir' => $store]);
        self::assertSame(12, $a->revision());
        $requests = $this->cdn()->stat('cdn', '200');
        $b = new KeepYourPrompts($this->options(['store' => 'file', 'state_dir' => $store]));
        self::assertSame('file', $b->status()->store);
        self::assertSame(12, $b->revision());
        self::assertSame($requests, $this->cdn()->stat('cdn', '200'));
        self::assertSame($a->storeKey(), $b->storeKey());
    }

    public function testEvictedStoreIsRefilledFromMemory(): void
    {
        $dir = $this->tmp . '/state';
        $c = $this->client(['poll_interval' => 0.0], new FileStore($dir));
        self::assertSame(12, $c->revision());
        foreach (glob($dir . '/kyp-php-state-*') ?: [] as $f) {
            unlink($f);
        }
        self::assertSame(12, $c->revision());
        self::assertNotEmpty(glob($dir . '/kyp-php-state-*'));
    }

    public function testCallbackErrorsAreContained(): void
    {
        $logged = [];
        $c = $this->client(['log_level' => 'error', 'logger' => static function (string $level, string $msg) use (&$logged): void {
            $logged[] = $level . ' ' . $msg;
        }]);
        $c->onUpdate(static function (): void {
            throw new \RuntimeException('boom');
        });
        self::assertSame(12, $c->revision());
        Fixtures::deploy('v13', $this->tmp . '/srv');
        self::assertTrue($c->refresh());
        self::assertSame(13, $c->revision());
        self::assertSame(['error onUpdate callback threw: boom'], $logged);
    }

    // ---------------------------------------------------------------------------------

    private function cdn(): FakeCdn
    {
        if ($this->cdn === null) {
            Fixtures::deploy('v12', $this->tmp . '/srv');
            $this->cdn = new FakeCdn([
                'cdn' => ['/v1/d/' . self::KEY, $this->tmp . '/srv'],
                'origin' => ['/v1/delivery/' . self::KEY, $this->tmp . '/srv'],
            ]);
        }

        return $this->cdn;
    }

    /**
     * @param array<string, mixed> $extra
     */
    private function options(array $extra = []): Options
    {
        return Options::fromArray(array_merge([
            'app' => 'demo',
            'delivery_key' => self::KEY,
            'cdn_url' => $this->cdn()->base() . '/v1/d',
            'origin_url' => $this->cdn()->base() . '/v1/delivery',
            'poll_interval' => 30,
            'log_level' => 'off',
        ], $extra));
    }

    /**
     * @param array<string, mixed> $extra
     */
    private function client(array $extra = [], ?\KeepYourPrompts\Store\StateStore $store = null): KeepYourPrompts
    {
        $options = $this->options($extra);

        return new KeepYourPrompts($options, $store ?? ($options->store === 'auto' ? new MemoryStore() : null));
    }
}
