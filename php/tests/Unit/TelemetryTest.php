<?php

declare(strict_types=1);

namespace KeepYourPrompts\Tests\Unit;

use KeepYourPrompts\Exception\MissingVariable;
use KeepYourPrompts\Exception\NotFound;
use KeepYourPrompts\KeepYourPrompts;
use KeepYourPrompts\Mirror;
use KeepYourPrompts\Options;
use KeepYourPrompts\PromptMeta;
use KeepYourPrompts\Telemetry\Observer;
use KeepYourPrompts\Telemetry\RefreshRecord;
use KeepYourPrompts\Telemetry\RenderError;
use KeepYourPrompts\Telemetry\Telemetry;
use KeepYourPrompts\Tests\Support\Fixtures;
use PHPUnit\Framework\TestCase;

/**
 * Prompt metadata and the observer hook (protocol/tracing.md), without OpenTelemetry.
 */
final class TelemetryTest extends TestCase
{
    private string $tmp = '';
    private string $good = '';
    private RecordingObserver $rec;
    private KeepYourPrompts $client;

    protected function setUp(): void
    {
        $this->tmp = Fixtures::tempDir();
        // Two folder mirrors: "broken" (a manifest that is not JSON) first, then "snapshot" (v12).
        @mkdir($this->tmp . '/broken/envs/demo', 0777, true);
        file_put_contents($this->tmp . '/broken/envs/demo/prod.json', 'not json');
        $this->good = $this->tmp . '/good';
        Fixtures::deploy('v12', $this->good);
        $this->rec = new RecordingObserver();
        $this->client = new KeepYourPrompts(new Options(
            app: 'demo',
            mirrors: [Mirror::file($this->tmp . '/broken', 'broken'), Mirror::file($this->good, 'snapshot')],
            store: 'memory',
            autoRefresh: false,
            logLevel: 'off',
            observer: $this->rec,
        ));
    }

    protected function tearDown(): void
    {
        Fixtures::remove($this->tmp);
    }

    public function testMetaAndRenderWithMeta(): void
    {
        $m = $this->client->meta('greeting');
        self::assertSame(
            ['greeting', 4, '5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d', 'demo', 'prod', 'acme', 12, 'snapshot'],
            [$m->name, $m->version, $m->sha256, $m->app, $m->env, $m->workspace, $m->revision, $m->source],
        );
        $r = $this->client->renderWithMeta('greeting', ['name' => 'Ada', 'company' => 'Acme']);
        self::assertSame($this->client->render('greeting', ['name' => 'Ada', 'company' => 'Acme']), $r->text);
        self::assertEquals($m, $r->meta);
        self::assertSame($r->text, (string) $r);
        $this->expectException(NotFound::class);
        $this->client->meta('nope');
    }

    public function testAttributesAndMetadataMaps(): void
    {
        $m = $this->client->meta('triage');
        $a = $m->attributes();
        self::assertSame([
            'kyp.prompt.name' => 'triage',
            'kyp.prompt.version' => 7,
            'kyp.prompt.sha256' => 'f31befda9f5a0fed97bb07f8164baf8673f4342fcca9ad37d59dafaacefc53bf',
            'kyp.app' => 'demo',
            'kyp.env' => 'prod',
            'kyp.revision' => 12,
            'kyp.workspace' => 'acme',
            'kyp.source' => 'snapshot',
            'gen_ai.prompt.name' => 'triage',
            'gen_ai.prompt.version' => '7',
        ], $a);
        self::assertArrayNotHasKey('gen_ai.prompt.name', $m->attributes(false));
        self::assertSame(
            ['kyp_prompt_name', 'kyp_prompt_version', 'kyp_prompt_sha256', 'kyp_app', 'kyp_env', 'kyp_revision', 'kyp_workspace', 'kyp_source'],
            array_keys($m->traceMetadata()),
        );
        self::assertSame($m->traceMetadata(), $m->langfuseMetadata());
        self::assertSame($m->traceMetadata(), $m->langsmithMetadata());
        $bare = new PromptMeta('a', 1, 'x', 'b', 'c', '', 0, '');
        self::assertArrayNotHasKey('kyp.workspace', $bare->attributes());
        self::assertArrayNotHasKey('kyp_source', $bare->traceMetadata());
    }

    public function testStartRoundWithFallbackAndUpdate(): void
    {
        $this->client->get('greeting');
        self::assertCount(1, $this->rec->refreshes);
        $r = $this->rec->refreshes[0];
        self::assertSame(['start', 'updated', 'snapshot', 'snapshot', 12, 0, 'acme'], [$r->trigger, $r->result, $r->mirror, $r->source, $r->revision, $r->previousRevision, $r->workspace]);
        self::assertSame(['kyp.fallback', 'kyp.update'], array_map(static fn ($e) => $e->name, $r->events));
        $fb = $r->events[0]->attributes;
        self::assertSame(['broken', 'snapshot', 'bad_manifest'], [$fb['kyp.mirror'], $fb['kyp.source'], $fb['error.type']]);
        self::assertSame(['kyp.revision.previous' => 0, 'kyp.revision' => 12, 'kyp.prompts.changed' => 4], $r->events[1]->attributes);
        self::assertGreaterThan(1.7e9, $r->startTime);
        self::assertGreaterThanOrEqual(0.0, $r->duration);
    }

    public function testUpdateNotModifiedAndHashMismatch(): void
    {
        $this->client->get('greeting');
        Fixtures::deploy('v13', $this->good);
        self::assertTrue($this->client->refresh());
        $r = end($this->rec->refreshes);
        self::assertSame(['manual', 'updated', 12, 13], [$r->trigger, $r->result, $r->previousRevision, $r->revision]);
        self::assertSame(1, $r->events[array_key_last($r->events)]->attributes['kyp.prompts.changed']);

        $this->client->refresh();
        self::assertSame('not_modified', end($this->rec->refreshes)->result);

        Fixtures::remove($this->good);
        Fixtures::deploy('tampered-v14', $this->good);
        self::assertFalse($this->client->refresh());
        $r = end($this->rec->refreshes);
        self::assertSame(['failed', '', 'blob_unavailable'], [$r->result, $r->source, $r->errorType]);
        $hm = array_values(array_filter($r->events, static fn ($e) => $e->name === 'kyp.hash_mismatch'));
        self::assertCount(1, $hm);
        self::assertSame(
            ['kyp.mirror' => 'snapshot', 'kyp.source' => 'snapshot', 'kyp.blob.sha256' => 'fcadfa6b70f5b153be065e4f32dc011328b1aff4749fb3b748bba68a60c0838e'],
            $hm[0]->attributes,
        );
        self::assertSame(13, $this->client->revision());
    }

    public function testRenderErrorsAndObserverIsolation(): void
    {
        try {
            $this->client->render('greeting', ['name' => 'Ada']);
            self::fail('expected MissingVariable');
        } catch (MissingVariable) {
        }
        try {
            $this->client->renderWithMeta('nope');
            self::fail('expected NotFound');
        } catch (NotFound) {
        }
        self::assertSame(
            [['greeting', 'missing_variable'], ['nope', 'not_found']],
            array_map(static fn (RenderError $e) => [$e->name, $e->errorType], $this->rec->renderErrors),
        );

        $boom = new class () implements Observer {
            public function onRefresh(RefreshRecord $record): void
            {
                throw new \RuntimeException('boom');
            }

            public function onRenderError(RenderError $error): void
            {
                throw new \RuntimeException('boom');
            }
        };
        $unsubscribe = $this->client->addObserver($boom);
        self::assertTrue($this->client->refresh());
        $unsubscribe();
        $extra = new RecordingObserver();
        $off = $this->client->addObserver($extra);
        $this->client->refresh();
        $off();
        $this->client->refresh();
        self::assertCount(1, $extra->refreshes);
    }

    public function testNormalizeAndClassify(): void
    {
        self::assertSame(
            ['cache', 'cdn', 'custom', 'snapshot', 'embedded', 'cache', ''],
            [
                Telemetry::normalizeSource('disk-cache', 'cache'), Telemetry::normalizeSource('cdn', 'http'),
                Telemetry::normalizeSource('eu', 'http'), Telemetry::normalizeSource('local', 'file'),
                Telemetry::normalizeSource('x', 'embedded'), Telemetry::normalizeSource('y', 'cache'),
                Telemetry::normalizeSource('', 'http'),
            ],
        );
        self::assertSame(
            ['http_503', 'not_found', 'timeout', 'network', 'stale', 'bad_manifest', '_OTHER'],
            array_map([Telemetry::class, 'classifyError'], [
                'HTTP 503', 'manifest not found (HTTP 404)', 'Operation timed out after 5001 milliseconds',
                'Failed to connect to 127.0.0.1 port 9: Couldn\'t connect to server', 'stale manifest ignored (revision 11 < held 12)',
                'bad manifest: not JSON', 'weird',
            ]),
        );
    }
}

final class RecordingObserver implements Observer
{
    /** @var list<RefreshRecord> */
    public array $refreshes = [];
    /** @var list<RenderError> */
    public array $renderErrors = [];

    public function onRefresh(RefreshRecord $record): void
    {
        $this->refreshes[] = $record;
    }

    public function onRenderError(RenderError $error): void
    {
        $this->renderErrors[] = $error;
    }
}
