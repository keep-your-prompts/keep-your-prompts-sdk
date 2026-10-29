<?php

declare(strict_types=1);

namespace KeepYourPrompts\Tests\Conformance;

use KeepYourPrompts\Exception\MissingVariable;
use KeepYourPrompts\Exception\ProtocolError;
use KeepYourPrompts\Http\CurlTransport;
use KeepYourPrompts\Http\StreamTransport;
use KeepYourPrompts\KeepYourPrompts;
use KeepYourPrompts\Manifest;
use KeepYourPrompts\OnMissing;
use KeepYourPrompts\Options;
use KeepYourPrompts\Store\FileStore;
use KeepYourPrompts\Store\MemoryStore;
use KeepYourPrompts\Store\StateStore;
use KeepYourPrompts\Template;
use KeepYourPrompts\Tests\Support\CountingStore;
use KeepYourPrompts\Tests\Support\CountingTransport;
use KeepYourPrompts\Tests\Support\FakeCdn;
use KeepYourPrompts\Tests\Support\Fixtures;
use KeepYourPrompts\Update;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The 12 required behaviours of conformance/README.md, against the shared fixtures.
 *
 * PHP adaptation: PHP is request-scoped, so "background refresher" means "at most one
 * request per poll interval revalidates" (behaviour 12 checks that across processes),
 * and refresh() runs one round on demand.
 */
final class ConformanceTest extends TestCase
{
    private const KEY = 'kypd_test';
    private const GREETING_V4 = 'Hello {{name}}, welcome to {{ company }}.';

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

    // 1. Render ------------------------------------------------------------------------

    /**
     * @return iterable<string, array{array<string, mixed>}>
     */
    public static function renderCases(): iterable
    {
        $cases = Fixtures::cases()['render'];
        self::assertIsArray($cases);
        foreach (array_values($cases) as $i => $case) {
            self::assertIsArray($case);
            /** @var array<string, mixed> $case */
            yield 'render #' . $i => [$case];
        }
    }

    /**
     * @param array<string, mixed> $case
     */
    #[DataProvider('renderCases')]
    public function testRender(array $case): void
    {
        $template = $case['template'];
        $vars = $case['vars'];
        self::assertIsString($template);
        self::assertIsArray($vars);
        /** @var array<string, string> $vars */
        $mode = ($case['lenient'] ?? false) === true ? OnMissing::Keep : OnMissing::Error;
        if (isset($case['error'])) {
            try {
                Template::render($template, $vars, $mode);
                self::fail('expected MissingVariable');
            } catch (MissingVariable $e) {
                self::assertSame('missing_variable', $case['error']);
                self::assertSame([$case['variable']], $e->names);
            }

            return;
        }
        self::assertSame($case['out'], Template::render($template, $vars, $mode));
    }

    // 2. Variables ---------------------------------------------------------------------

    public function testVariables(): void
    {
        $cases = Fixtures::cases()['variables'];
        self::assertIsArray($cases);
        self::assertNotEmpty($cases);
        foreach ($cases as $case) {
            self::assertIsArray($case);
            self::assertIsString($case['template']);
            self::assertSame($case['out'], Template::variables($case['template']));
        }
    }

    // 3. Manifest ----------------------------------------------------------------------

    public function testManifest(): void
    {
        $cases = Fixtures::cases()['manifest'];
        self::assertIsArray($cases);
        foreach ($cases as $case) {
            self::assertIsArray($case);
            $json = isset($case['file'])
                ? (string) file_get_contents(Fixtures::conformanceDir() . '/' . (is_string($case['file']) ? $case['file'] : ''))
                : json_encode($case['json'], JSON_THROW_ON_ERROR);
            if ($case['valid'] !== true) {
                try {
                    Manifest::parse($json, 'demo', 'prod');
                    self::fail('expected ProtocolError: ' . (is_string($case['why'] ?? null) ? $case['why'] : ''));
                } catch (ProtocolError) {
                    $this->addToAssertionCount(1);
                }
                continue;
            }
            $m = Manifest::parse($json, 'demo', 'prod');
            if (isset($case['prompts'])) {
                self::assertSame($case['prompts'], array_keys($m->prompts));
            }
            }
        $unknown = Manifest::parse((string) json_encode([
            'schema' => 1, 'workspace' => 'a', 'app' => 'demo', 'env' => 'prod', 'revision' => 1, 'deployed_at' => 'x', 'x' => [1],
            'prompts' => ['p' => ['sha256' => str_repeat('e', 64), 'version' => 1, 'future' => 1]],
        ]), 'demo', 'prod');
        self::assertSame([], $unknown->prompts['p']->variables);
    }

    // 4. Hash check --------------------------------------------------------------------

    public function testTamperedBlobIsRejected(): void
    {
        // Only the tampered mirror: nothing may be served from it.
        $c = new KeepYourPrompts(new Options(app: 'demo', snapshotDir: Fixtures::dir('tampered-v14'), startEmpty: true, logLevel: 'off'), new MemoryStore());
        self::assertFalse($c->status()->ready || $c->has('greeting'));
        self::assertStringContainsString('sha256', $c->status()->lastError);

        // Holding 12, a deploy of the tampered 14 everywhere is refused and 12 stays.
        $c = $this->networkClient();
        self::assertSame(12, $c->revision());
        foreach (['cdn', 'origin', 'git'] as $route) {
            Fixtures::deploy('tampered-v14', $this->tmp . '/' . $route);
        }
        self::assertFalse($c->refresh());
        self::assertSame(12, $c->revision());
        self::assertSame(self::GREETING_V4, $c->get('greeting'));
        self::assertStringContainsString('failed sha256 verification', $c->status()->lastError);
    }

    // 5. Start from local --------------------------------------------------------------

    public function testStartsFromSnapshotWithoutNetwork(): void
    {
        $start = microtime(true);
        $c = new KeepYourPrompts(new Options(app: 'demo', snapshotDir: Fixtures::dir('v12'), logLevel: 'off'), new MemoryStore());
        $p = $c->prompt('greeting');
        self::assertLessThan(0.5, microtime(true) - $start);
        self::assertSame(4, $p->version);
        self::assertSame(['name', 'company'], $p->variables);
        self::assertSame('Hello Ana, welcome to Acme.', $c->render('greeting', ['name' => 'Ana', 'company' => 'Acme']));
        self::assertSame('You are a support agent for Acme. Literal {{braces}} stay.', $c->render('triage', ['company' => 'Acme']));
        self::assertSame('Review the diff.', $c->get('agents/reviewer'));
        self::assertSame('', $c->get('empty'));
        self::assertSame('snapshot', $c->status()->source);
        self::assertSame(['agents/reviewer', 'empty', 'greeting', 'triage'], $c->names());
    }

    // 6. Mirror order and fallback -----------------------------------------------------

    public function testMirrorOrderAndFallback(): void
    {
        $c = $this->networkClient();
        $cdn = $this->cdn();
        self::assertSame('cdn', $c->status()->source);
        self::assertSame(0, $cdn->stat('origin', '200'));

        $cdn->down('cdn');
        self::assertTrue($c->refresh());
        self::assertSame('origin', $c->status()->source);
        self::assertStringContainsString('cdn: HTTP 503', $c->status()->lastError);

        $cdn->down('origin');
        self::assertTrue($c->refresh());
        self::assertSame('git', $c->status()->source);
        self::assertSame('Bearer ghtok', $cdn->stat('git', 'auth'));
        self::assertSame(self::GREETING_V4, $c->get('greeting'));

        // A fresh client with CDN and origin down starts from git.
        $fresh = $this->networkClient(store: new MemoryStore());
        self::assertSame('git', $fresh->status()->source);
        self::assertSame(12, $fresh->revision());

        $cdn->up('cdn');
        $cdn->up('origin');
        self::assertTrue($c->refresh());
        self::assertSame('cdn', $c->status()->source);
        self::assertSame('', $c->status()->lastError);
    }

    // 7. Revalidation ------------------------------------------------------------------

    public function testRevalidationSendsIfNoneMatchAnd304ChangesNothing(): void
    {
        $transport = new CountingTransport(extension_loaded('curl') ? new CurlTransport() : new StreamTransport());
        $updates = 0;
        $c = $this->networkClient(transport: $transport);
        $c->onUpdate(static function () use (&$updates): void {
            $updates++;
        });
        $manifestRequests = static fn (): array => array_values(array_filter($transport->requests, static fn (array $r): bool => str_contains($r[0], '/envs/')));
        self::assertTrue($c->refresh());
        self::assertTrue($c->refresh());
        $requests = $manifestRequests();
        self::assertCount(3, $requests);
        self::assertArrayNotHasKey('If-None-Match', $requests[0][1]);
        self::assertArrayHasKey('If-None-Match', $requests[1][1]);
        self::assertSame($requests[1][1]['If-None-Match'], $requests[2][1]['If-None-Match']);
        self::assertSame(2, $this->cdn()->stat('cdn', '304'));
        self::assertSame(12, $c->revision());
        self::assertSame(0, $updates);
        self::assertSame('cdn', $c->status()->source);
    }

    // 8. Hot update --------------------------------------------------------------------

    public function testHotUpdateSwapsWithoutRestartAndFiresCallbackOnce(): void
    {
        $c = $this->networkClient();
        /** @var list<Update> $updates */
        $updates = [];
        $c->onUpdate(static function (Update $u) use (&$updates): void {
            $updates[] = $u;
        });
        self::assertSame(4, $c->prompt('greeting')->version);
        Fixtures::deploy('v13', $this->tmp . '/cdn');
        self::assertTrue($c->refresh());
        self::assertSame(5, $c->prompt('greeting')->version);
        self::assertSame(13, $c->revision());
        self::assertTrue($c->refresh());
        self::assertCount(1, $updates);
        self::assertSame(12, $updates[0]->oldRevision);
        self::assertSame(13, $updates[0]->newRevision);
        self::assertSame(['greeting'], $updates[0]->changed);
        self::assertSame('cdn', $updates[0]->source);
    }

    // 9. Stale mirror ------------------------------------------------------------------

    public function testStaleMirrorNeverReplacesNewerRevision(): void
    {
        $c = $this->networkClient();
        foreach (['cdn', 'origin', 'git'] as $route) {
            Fixtures::remove($this->tmp . '/' . $route);
            Fixtures::deploy('v11-stale', $this->tmp . '/' . $route);
        }
        $c->refresh();
        self::assertSame(12, $c->revision());
        self::assertSame(4, $c->prompt('greeting')->version);
        self::assertStringContainsString('stale manifest ignored (revision 11 < held 12)', $c->status()->lastError);
    }

    // 10. Failures never evict ---------------------------------------------------------

    public function testFailuresNeverEvict(): void
    {
        $c = $this->networkClient(cacheDir: $this->tmp . '/cache');
        $cdn = $this->cdn();
        foreach (['cdn', 'origin', 'git'] as $route) {
            $cdn->down($route);
        }
        self::assertFalse($c->refresh());
        usleep(50_000);
        self::assertSame(self::GREETING_V4, $c->get('greeting'));
        $st = $c->status();
        self::assertTrue($st->ready);
        self::assertSame(12, $st->revision);
        self::assertStringContainsString('cdn: HTTP 503', $st->lastError);
        self::assertStringContainsString('origin: HTTP 503', $st->lastError);
        self::assertStringContainsString('git: HTTP 503', $st->lastError);
        self::assertGreaterThan(0.04, $st->staleFor);
        self::assertNotNull($st->lastSuccess);
        self::assertSame('cdn', $st->mirrors[1]->name); // disk-cache, cdn, origin, git
        self::assertSame(1, $st->mirrors[1]->consecutiveFailures);
    }

    // 11. Disk cache -------------------------------------------------------------------

    public function testRestartsFromDiskCacheWithoutNetwork(): void
    {
        $cache = $this->tmp . '/cache';
        $c = $this->networkClient(cacheDir: $cache);
        self::assertSame(12, $c->revision());
        self::assertFileExists($cache . '/acme/demo/prod/envs/demo/prod.json');
        self::assertFileExists($cache . '/acme/demo/prod/blobs/5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d');

        $this->cdn = null; // no network at all
        $start = microtime(true);
        $restarted = new KeepYourPrompts(new Options(
            app: 'demo',
            deliveryKey: self::KEY,
            cdnBase: 'http://127.0.0.1:9/v1/d',
            originBase: 'http://127.0.0.1:9/v1/delivery',
            cacheDir: $cache,
            logLevel: 'off',
        ), new MemoryStore());
        self::assertSame(self::GREETING_V4, $restarted->get('greeting'));
        self::assertLessThan(0.5, microtime(true) - $start);
        self::assertSame('disk-cache', $restarted->status()->source);
        self::assertSame(12, $restarted->revision());
    }

    // 12. Read path --------------------------------------------------------------------

    public function testReadPathDoesNoIo(): void
    {
        $transport = new CountingTransport(extension_loaded('curl') ? new CurlTransport() : new StreamTransport());
        $store = new CountingStore(new MemoryStore());
        $c = $this->networkClient(store: $store, transport: $transport, poll: 30.0);
        $c->get('greeting');
        [$calls, $loads, $saves] = [$transport->calls, $store->loads, $store->saves];
        for ($i = 0; $i < 20_000; $i++) {
            $c->get('greeting');
            $c->render('triage', ['company' => 'Acme']);
            $c->prompt('agents/reviewer');
        }
        self::assertSame([$calls, $loads, $saves], [$transport->calls, $store->loads, $store->saves]);
    }

    /**
     * PHP has no threads; "many at once" means many processes sharing one store. With
     * the poll interval elapsed, concurrent requests revalidate exactly once.
     */
    public function testConcurrentProcessesRevalidateOnce(): void
    {
        $stateDir = $this->tmp . '/state';
        $poll = 1.5;
        $c = $this->networkClient(store: new FileStore($stateDir), poll: $poll);
        self::assertSame(12, $c->revision());
        $cdn = $this->cdn();
        self::assertSame(0, $cdn->stat('cdn', '304'));
        $fetched = $cdn->stat('cdn', '200');

        $autoload = getenv('KYP_TEST_AUTOLOAD') ?: dirname(__DIR__, 2) . '/vendor/autoload.php';
        $go = $this->tmp . '/go';
        $script = $this->tmp . '/child.php';
        file_put_contents($script, sprintf(<<<'PHP'
            <?php
            require %s;
            $c = new KeepYourPrompts\KeepYourPrompts(new KeepYourPrompts\Options(
                app: 'demo', deliveryKey: 'kypd_test', cdnBase: %s, originBase: %s, gitMirror: %s, gitToken: 'ghtok',
                pollInterval: %F, maxBackoff: 0.5, logLevel: 'off',
            ), new KeepYourPrompts\Store\FileStore(%s));
            while (!file_exists(%s)) { usleep(1000); }
            echo $c->get('greeting') === %s ? 'ok' : 'bad';
            PHP,
            var_export($autoload, true),
            var_export($cdn->base() . '/v1/d', true),
            var_export($cdn->base() . '/v1/delivery', true),
            var_export($cdn->base() . '/acme/prompts/main/.kyp', true),
            $poll,
            var_export($stateDir, true),
            var_export($go, true),
            var_export(self::GREETING_V4, true),
        ));
        usleep((int) (($poll + 0.1) * 1e6));
        $procs = [];
        for ($i = 0; $i < 8; $i++) {
            $p = proc_open([PHP_BINARY, $script], [1 => ['pipe', 'w']], $pipes);
            self::assertIsResource($p);
            $procs[] = [$p, $pipes[1]];
        }
        usleep(300_000);
        touch($go);
        foreach ($procs as [$p, $out]) {
            self::assertSame('ok', stream_get_contents($out));
            proc_close($p);
        }
        self::assertSame(1, $cdn->stat('cdn', '304'), 'exactly one process revalidated');
        self::assertSame($fetched, $cdn->stat('cdn', '200'), 'nothing was fetched again');
    }

    // ---------------------------------------------------------------------------------

    private function cdn(): FakeCdn
    {
        if ($this->cdn === null) {
            foreach (['cdn', 'origin', 'git'] as $route) {
                Fixtures::deploy('v12', $this->tmp . '/' . $route);
            }
            $this->cdn = new FakeCdn([
                'cdn' => ['/v1/d/' . self::KEY, $this->tmp . '/cdn'],
                'origin' => ['/v1/delivery/' . self::KEY, $this->tmp . '/origin'],
                'git' => ['/acme/prompts/main/.kyp', $this->tmp . '/git'],
            ]);
        }

        return $this->cdn;
    }

    private function networkClient(
        ?StateStore $store = null,
        ?CountingTransport $transport = null,
        ?string $cacheDir = null,
        float $poll = 0.2,
    ): KeepYourPrompts {
        $cdn = $this->cdn();

        $client = new KeepYourPrompts(new Options(
            app: 'demo',
            deliveryKey: self::KEY,
            cdnBase: $cdn->base() . '/v1/d',
            originBase: $cdn->base() . '/v1/delivery',
            gitMirror: $cdn->base() . '/acme/prompts/main/.kyp',
            gitToken: 'ghtok',
            cacheDir: $cacheDir,
            pollInterval: $poll,
            maxBackoff: 0.5,
            logLevel: 'off',
        ), $store ?? new MemoryStore(), $transport);
        $client->revision(); // first read: loads (PHP clients are lazy)

        return $client;
    }
}
