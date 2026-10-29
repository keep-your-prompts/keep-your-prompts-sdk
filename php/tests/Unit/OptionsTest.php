<?php

declare(strict_types=1);

namespace KeepYourPrompts\Tests\Unit;

use KeepYourPrompts\Exception\KypException;
use KeepYourPrompts\Mirror;
use KeepYourPrompts\Options;
use PHPUnit\Framework\TestCase;

final class OptionsTest extends TestCase
{
    private const VARS = ['KYP_APP', 'KYP_ENV', 'KYP_DELIVERY_KEY', 'KYP_POLL_INTERVAL', 'KYP_STORE', 'KYP_LOG', 'KYP_CACHE_DIR'];

    protected function tearDown(): void
    {
        foreach (self::VARS as $v) {
            putenv($v);
            unset($_ENV[$v], $_SERVER[$v]);
        }
    }

    public function testFromEnvWithOverrides(): void
    {
        putenv('KYP_APP=support-bot');
        putenv('KYP_ENV=staging');
        putenv('KYP_DELIVERY_KEY=kypd_abc');
        putenv('KYP_POLL_INTERVAL=12.5');
        putenv('KYP_STORE=memory');
        putenv('KYP_LOG=off');
        $o = Options::fromEnv(['env' => 'prod', 'cache_dir' => null]);
        self::assertSame('support-bot', $o->app);
        self::assertSame('prod', $o->env);
        self::assertSame('kypd_abc', $o->deliveryKey);
        self::assertSame(12.5, $o->pollInterval);
        self::assertSame('memory', $o->store);
        self::assertSame('off', $o->logLevel);
        self::assertNull($o->cacheDir);
    }

    public function testFromArray(): void
    {
        $o = Options::fromArray([
            'app' => 'a', 'delivery_key' => '', 'start_empty' => 'true', 'auto_refresh' => '0',
            'mirrors' => [['name' => 'm', 'url' => '/srv'], Mirror::http('https://x/y', 'h', 't')],
            'logger' => static function (string $level, string $msg): void {
            },
        ]);
        self::assertNull($o->deliveryKey);
        self::assertTrue($o->startEmpty);
        self::assertFalse($o->autoRefresh);
        self::assertNotNull($o->mirrors);
        self::assertSame('m', $o->mirrors[0]->name);
        self::assertTrue($o->mirrors[1]->isHttp());
        self::assertNotNull($o->logger);
    }

    public function testValidation(): void
    {
        foreach ([['app' => ''], ['app' => 'Bad'], ['app' => 'a', 'env' => 'x y'], ['app' => 'a', 'store' => 'redis'],
            ['app' => 'a', 'log_level' => 'loud'], ['app' => 'a', 'poll_interval' => 'soon'], ['app' => 'a', 'request_timeout' => 0],
            ['app' => 'a', 'mirrors' => [['url' => '/x']]]] as $bad) {
            try {
                Options::fromArray($bad);
                self::fail('accepted ' . json_encode($bad));
            } catch (KypException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    public function testMirrorPaths(): void
    {
        self::assertSame('/opt/my app', Mirror::file('file:///opt/my%20app')->path());
        self::assertSame('/opt/x', Mirror::file('/opt/x')->path());
        self::assertFalse(Mirror::file('/opt/x')->isHttp());
    }
}
