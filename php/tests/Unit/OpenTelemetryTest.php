<?php

declare(strict_types=1);

namespace KeepYourPrompts\Tests\Unit;

use KeepYourPrompts\Exception\MissingVariable;
use KeepYourPrompts\Exception\NotFound;
use KeepYourPrompts\KeepYourPrompts;
use KeepYourPrompts\Mirror;
use KeepYourPrompts\OpenTelemetry\Instrumentation;
use KeepYourPrompts\Options;
use KeepYourPrompts\Tests\Support\Fixtures;
use OpenTelemetry\API\Trace\SpanKind;
use OpenTelemetry\API\Trace\StatusCode;
use OpenTelemetry\SDK\Metrics\Data\Gauge;
use OpenTelemetry\SDK\Metrics\Data\Histogram;
use OpenTelemetry\SDK\Metrics\Data\Metric;
use OpenTelemetry\SDK\Metrics\Data\Sum;
use OpenTelemetry\SDK\Metrics\Data\Temporality;
use OpenTelemetry\SDK\Metrics\MeterProvider;
use OpenTelemetry\SDK\Metrics\MetricExporter\InMemoryExporter as MetricExporter;
use OpenTelemetry\SDK\Metrics\MetricReader\ExportingReader;
use OpenTelemetry\SDK\Trace\ImmutableSpan;
use OpenTelemetry\SDK\Trace\SpanExporter\InMemoryExporter;
use OpenTelemetry\SDK\Trace\SpanProcessor\SimpleSpanProcessor;
use OpenTelemetry\SDK\Trace\TracerProvider;
use PHPUnit\Framework\TestCase;

/**
 * The optional OpenTelemetry add-on, against the SDK's in-memory exporters (protocol/tracing.md,
 * conformance checklist).
 */
final class OpenTelemetryTest extends TestCase
{
    private string $tmp = '';
    private string $good = '';
    private InMemoryExporter $spans;
    private TracerProvider $tracerProvider;
    private MetricExporter $metrics;
    private ExportingReader $reader;
    private MeterProvider $meterProvider;
    private ?Instrumentation $otel = null;
    private ?KeepYourPrompts $client = null;

    protected function setUp(): void
    {
        if (!Instrumentation::available() || !class_exists(TracerProvider::class)) {
            self::markTestSkipped('open-telemetry/sdk is not installed');
        }
        $this->spans = new InMemoryExporter();
        $this->tracerProvider = new TracerProvider(new SimpleSpanProcessor($this->spans));
        $this->metrics = new MetricExporter(temporality: Temporality::CUMULATIVE);
        $this->reader = new ExportingReader($this->metrics);
        $this->meterProvider = MeterProvider::builder()->addReader($this->reader)->build();

        $this->tmp = Fixtures::tempDir();
        @mkdir($this->tmp . '/broken/envs/demo', 0777, true);
        file_put_contents($this->tmp . '/broken/envs/demo/prod.json', 'not json');
        $this->good = $this->tmp . '/good';
        Fixtures::deploy('v12', $this->good);
    }

    protected function tearDown(): void
    {
        $this->otel?->shutdown();
        putenv('KYP_OTEL_CAPTURE_CONTENT');
        Fixtures::remove($this->tmp);
    }

    private function start(bool $captureContent = false, bool $genAi = true, bool $openInference = false, bool $traceAll = false): KeepYourPrompts
    {
        $this->otel = Instrumentation::create($this->tracerProvider, $this->meterProvider, $captureContent, $genAi, $openInference, $traceAll);
        $this->client = new KeepYourPrompts(new Options(
            app: 'demo',
            mirrors: [Mirror::file($this->tmp . '/broken', 'broken'), Mirror::file($this->good, 'snapshot')],
            store: 'memory',
            autoRefresh: false,
            logLevel: 'off',
            observer: $this->otel,
        ));
        $this->otel->attach($this->client);
        $this->client->get('greeting'); // the start-up load

        return $this->client;
    }

    /**
     * @param callable(): void $fn
     */
    private function inLlmSpan(callable $fn): ImmutableSpan
    {
        $span = $this->tracerProvider->getTracer('app')->spanBuilder('llm.call')->startSpan();
        $scope = $span->activate();
        try {
            $fn();
        } finally {
            $scope->detach();
            $span->end();
        }

        return $this->span('llm.call')[0];
    }

    /**
     * @return list<ImmutableSpan>
     */
    private function span(string $name): array
    {
        $out = [];
        foreach ($this->spans->getSpans() as $s) {
            if ($s instanceof ImmutableSpan && $s->getName() === $name) {
                $out[] = $s;
            }
        }

        return $out;
    }

    private function metric(string $name): Metric
    {
        $this->reader->collect();
        foreach (array_reverse($this->metrics->collect()) as $m) {
            if ($m instanceof Metric && $m->name === $name) {
                return $m;
            }
        }
        self::fail('no metric ' . $name);
    }

    /**
     * @return list<array{attributes: array<string, mixed>, value: int|float, count: int}>
     */
    private function points(string $name): array
    {
        $data = $this->metric($name)->data;
        $out = [];
        if ($data instanceof Histogram) {
            foreach ($data->dataPoints as $p) {
                $out[] = ['attributes' => $p->attributes->toArray(), 'value' => $p->sum, 'count' => $p->count];
            }
        } elseif ($data instanceof Sum || $data instanceof Gauge) {
            foreach ($data->dataPoints as $p) {
                $out[] = ['attributes' => $p->attributes->toArray(), 'value' => $p->value, 'count' => 1];
            }
        }

        return $out;
    }

    public function testAnnotateSetsKypAndGenAiAttributesWithoutContent(): void
    {
        $this->start();
        $meta = null;
        $span = $this->inLlmSpan(function () use (&$meta): void {
            $meta = $this->otel?->annotate('greeting', variables: ['name' => 'Ada']);
        });
        self::assertSame('greeting', $meta?->name);
        self::assertEquals([
            'kyp.prompt.name' => 'greeting',
            'kyp.prompt.version' => 4,
            'kyp.prompt.sha256' => '5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d',
            'kyp.app' => 'demo',
            'kyp.env' => 'prod',
            'kyp.revision' => 12,
            'kyp.workspace' => 'acme',
            'kyp.source' => 'snapshot',
            'gen_ai.prompt.name' => 'greeting',
            'gen_ai.prompt.version' => '4',
        ], $span->getAttributes()->toArray());
    }

    public function testCaptureContentAndOpenInference(): void
    {
        $c = $this->start(captureContent: true, openInference: true);
        $r = $c->renderWithMeta('greeting', ['name' => 'Ada', 'company' => 'Acme']);
        $a = $this->inLlmSpan(fn () => $this->otel?->annotate($r, variables: ['name' => 'Ada', 'company' => 'Acme']))->getAttributes()->toArray();
        self::assertSame($c->get('greeting'), $a['kyp.prompt.template']);
        self::assertSame(['Ada', 'Acme'], [$a['gen_ai.prompt.variable.name'], $a['gen_ai.prompt.variable.company']]);
        self::assertSame(['keepyourprompts', 'demo/prod/greeting', '4'], [$a['prompt.vendor'], $a['prompt.id'], $a['llm.prompt_template.version']]);
        self::assertSame(['name' => 'Ada', 'company' => 'Acme'], json_decode((string) $a['llm.prompt_template.variables'], true));
    }

    public function testStaticAnnotateExplicitSpanAndEnvCapture(): void
    {
        $c = $this->start(genAi: false);
        $tracer = $this->tracerProvider->getTracer('app');
        $span = $tracer->spanBuilder('explicit')->startSpan();
        Instrumentation::annotateSpan($c->meta('triage'), $span, ['company' => 'Acme'], genAiAttributes: false);
        $span->end();
        $a = $this->span('explicit')[0]->getAttributes()->toArray();
        self::assertSame(7, $a['kyp.prompt.version']);
        self::assertArrayNotHasKey('gen_ai.prompt.name', $a);
        self::assertSame([], array_filter(array_keys($a), static fn (string $k) => str_starts_with($k, 'gen_ai.prompt.variable.')));

        putenv('KYP_OTEL_CAPTURE_CONTENT=true');
        $span = $tracer->spanBuilder('env')->startSpan();
        Instrumentation::annotateSpan($c->meta('triage'), $span, ['company' => 'Acme']);
        $span->end();
        self::assertSame('Acme', $this->span('env')[0]->getAttributes()->get('gen_ai.prompt.variable.company'));
    }

    public function testAnnotateWithoutRecordingSpanIsANoOp(): void
    {
        $this->start();
        self::assertSame(7, $this->otel?->annotate('triage')->version);
        $this->expectException(NotFound::class);
        $this->otel?->annotate('nope');
    }

    private function runScenario(): void
    {
        $c = $this->start();
        Fixtures::deploy('v13', $this->good);
        $this->inLlmSpan(fn () => $c->refresh());
        Fixtures::remove($this->good);
        Fixtures::deploy('tampered-v14', $this->good);
        $c->refresh();
    }

    public function testRefreshSpansAndEvents(): void
    {
        $this->runScenario();
        [$start, $update, $bad] = $this->span('kyp.refresh');

        self::assertSame(SpanKind::KIND_INTERNAL, $start->getKind());
        self::assertEquals([
            'kyp.app' => 'demo',
            'kyp.env' => 'prod',
            'kyp.refresh.trigger' => 'start',
            'kyp.refresh.result' => 'updated',
            'kyp.revision' => 12,
            'kyp.workspace' => 'acme',
            'kyp.source' => 'snapshot',
            'kyp.mirror' => 'snapshot',
        ], $start->getAttributes()->toArray());
        self::assertSame(['kyp.fallback', 'kyp.update'], array_map(static fn ($e) => $e->getName(), $start->getEvents()));
        self::assertSame('bad_manifest', $start->getEvents()[0]->getAttributes()->get('error.type'));
        self::assertFalse($start->getParentContext()->isValid());

        $a = $update->getAttributes();
        self::assertSame(['manual', 'updated', 13], [$a->get('kyp.refresh.trigger'), $a->get('kyp.refresh.result'), $a->get('kyp.revision')]);
        self::assertSame($this->span('llm.call')[0]->getSpanId(), $update->getParentSpanId());
        $events = $update->getEvents();
        self::assertSame(['kyp.revision.previous' => 12, 'kyp.revision' => 13, 'kyp.prompts.changed' => 1], $events[count($events) - 1]->getAttributes()->toArray());

        self::assertContains('kyp.hash_mismatch', array_map(static fn ($e) => $e->getName(), $bad->getEvents()));
        self::assertSame(['failed', 'blob_unavailable'], [$bad->getAttributes()->get('kyp.refresh.result'), $bad->getAttributes()->get('error.type')]);
        self::assertSame(StatusCode::STATUS_ERROR, $bad->getStatus()->getCode());
        self::assertNull($bad->getAttributes()->get('kyp.source'));
    }

    public function testRefreshMetrics(): void
    {
        $this->runScenario();
        $duration = $this->metric('kyp.refresh.duration');
        self::assertSame('s', $duration->unit);
        $points = $this->points('kyp.refresh.duration');
        self::assertSame(3, array_sum(array_column($points, 'count')));
        self::assertSame(['kyp.app' => 'demo', 'kyp.env' => 'prod', 'kyp.refresh.trigger' => 'start', 'kyp.refresh.result' => 'updated', 'kyp.source' => 'snapshot'], $points[0]['attributes']);

        $fallbacks = $this->points('kyp.fallbacks');
        self::assertSame(4, array_sum(array_column($fallbacks, 'value'))); // broken x3 + the tampered snapshot
        self::assertSame(['kyp.app' => 'demo', 'kyp.env' => 'prod', 'kyp.source' => 'snapshot', 'kyp.mirror' => 'broken', 'error.type' => 'bad_manifest'], $fallbacks[0]['attributes']);
        self::assertSame(1, array_sum(array_column($this->points('kyp.hash_mismatches'), 'value')));
        $revision = $this->points('kyp.revision');
        self::assertSame(13, $revision[0]['value']);
        self::assertSame(['kyp.app' => 'demo', 'kyp.env' => 'prod'], $revision[0]['attributes']);
        self::assertGreaterThanOrEqual(0, $this->points('kyp.staleness')[0]['value']);
    }

    public function testUneventfulRoundsAreNotTracedUnlessAsked(): void
    {
        // The first mirror answers: no fallback events.
        Fixtures::deploy('v12', $this->tmp . '/broken');
        $c = $this->start();
        $c->refresh();
        self::assertCount(1, $this->span('kyp.refresh'));
        self::assertSame(2, array_sum(array_column($this->points('kyp.refresh.duration'), 'count')));

        $this->otel?->shutdown();
        $c = $this->start(traceAll: true);
        $c->refresh();
        $triggers = array_map(static fn ($s) => $s->getAttributes()->get('kyp.refresh.trigger'), $this->span('kyp.refresh'));
        self::assertSame(['start', 'start', 'manual'], $triggers);
        $all = $this->span('kyp.refresh');
        self::assertSame('not_modified', $all[2]->getAttributes()->get('kyp.refresh.result'));
    }

    public function testRenderErrorsMetric(): void
    {
        $c = $this->start();
        try {
            $c->render('greeting', ['name' => 'Ada']);
        } catch (MissingVariable) {
        }
        try {
            $c->render('nope');
        } catch (NotFound) {
        }
        $points = array_map(static fn ($p) => [$p['attributes']['kyp.prompt.name'], $p['attributes']['error.type']], $this->points('kyp.render.errors'));
        sort($points);
        self::assertSame([['greeting', 'missing_variable'], ['nope', 'not_found']], $points);
    }
}
