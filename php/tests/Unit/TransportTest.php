<?php

declare(strict_types=1);

namespace KeepYourPrompts\Tests\Unit;

use KeepYourPrompts\Exception\TransportException;
use KeepYourPrompts\Http\CurlTransport;
use KeepYourPrompts\Http\Psr18Transport;
use KeepYourPrompts\Http\StreamTransport;
use KeepYourPrompts\Http\Transport;
use KeepYourPrompts\KeepYourPrompts;
use KeepYourPrompts\Options;
use KeepYourPrompts\Store\MemoryStore;
use KeepYourPrompts\Tests\Support\FakeCdn;
use KeepYourPrompts\Tests\Support\Fixtures;
use Nyholm\Psr7\Factory\Psr17Factory;
use Nyholm\Psr7\Response;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Http\Client\ClientExceptionInterface;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;

final class TransportTest extends TestCase
{
    /**
     * @return iterable<string, array{Transport}>
     */
    public static function transports(): iterable
    {
        yield 'stream' => [new StreamTransport()];
        if (extension_loaded('curl')) {
            yield 'curl' => [new CurlTransport()];
        }
    }

    #[DataProvider('transports')]
    public function testEtagsAnd304(Transport $t): void
    {
        $cdn = new FakeCdn(['cdn' => ['/v1/d/kypd_x', Fixtures::dir('v12')]]);
        $url = $cdn->base() . '/v1/d/kypd_x/envs/demo/prod.json';
        $r = $t->get($url, ['Authorization' => 'Bearer tok'], 1, 2);
        self::assertSame(200, $r->status);
        self::assertStringContainsString('"revision": 12', $r->body);
        self::assertNotSame('', $r->header('ETag'));
        self::assertSame('Bearer tok', $cdn->stat('cdn', 'auth'));
        $again = $t->get($url, ['If-None-Match' => $r->header('etag')], 1, 2);
        self::assertSame(304, $again->status);
        self::assertSame('', $again->body);
        self::assertSame(404, $t->get($cdn->base() . '/v1/d/kypd_x/envs/demo/nope.json', [], 1, 2)->status);
    }

    #[DataProvider('transports')]
    public function testConnectionRefused(Transport $t): void
    {
        $this->expectException(TransportException::class);
        $t->get('http://127.0.0.1:9/x', [], 0.5, 1);
    }

    public function testPsr18Adapter(): void
    {
        $client = new class () implements ClientInterface {
            public ?RequestInterface $last = null;

            public function sendRequest(RequestInterface $request): ResponseInterface
            {
                $this->last = $request;
                if ($request->getUri()->getHost() === 'down.example') {
                    throw new class ('refused') extends \RuntimeException implements ClientExceptionInterface {
                    };
                }

                return new Response(200, ['ETag' => '"abc"', 'X-Two' => ['a', 'b']], 'body');
            }
        };
        $t = new Psr18Transport($client, new Psr17Factory());
        $r = $t->get('https://cdn.example/x', ['If-None-Match' => '"old"'], 1, 1);
        self::assertSame(200, $r->status);
        self::assertSame('body', $r->body);
        self::assertSame('"abc"', $r->header('etag'));
        self::assertSame('a, b', $r->header('x-two'));
        self::assertNotNull($client->last);
        self::assertSame('"old"', $client->last->getHeaderLine('If-None-Match'));
        $this->expectException(TransportException::class);
        $t->get('https://down.example/x', [], 1, 1);
    }

    public function testClientWorksOverPsr18(): void
    {
        $dir = Fixtures::dir('v12');
        $client = new class ($dir) implements ClientInterface {
            public function __construct(private readonly string $dir)
            {
            }

            public function sendRequest(RequestInterface $request): ResponseInterface
            {
                $rel = (string) preg_replace('#^/v1/d/kypd_x/#', '', $request->getUri()->getPath());
                $file = $this->dir . '/' . $rel;

                return is_file($file) ? new Response(200, [], (string) file_get_contents($file)) : new Response(404);
            }
        };
        $c = new KeepYourPrompts(
            new Options(app: 'demo', deliveryKey: 'kypd_x', cdnBase: 'https://cdn.example/v1/d', logLevel: 'off'),
            new MemoryStore(),
            new Psr18Transport($client, new Psr17Factory()),
        );
        self::assertSame(4, $c->prompt('greeting')->version);
        self::assertSame('cdn', $c->status()->source);
    }
}
