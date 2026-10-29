<?php

declare(strict_types=1);

namespace KeepYourPrompts\OpenTelemetry;

use KeepYourPrompts\Exception\KypException;
use KeepYourPrompts\KeepYourPrompts;
use KeepYourPrompts\Options;
use KeepYourPrompts\PromptMeta;
use KeepYourPrompts\Rendered;
use KeepYourPrompts\Telemetry\Observer;
use KeepYourPrompts\Telemetry\RefreshRecord;
use KeepYourPrompts\Telemetry\RenderError;
use OpenTelemetry\API\Globals;
use OpenTelemetry\API\Metrics\CounterInterface;
use OpenTelemetry\API\Metrics\HistogramInterface;
use OpenTelemetry\API\Metrics\MeterProviderInterface;
use OpenTelemetry\API\Metrics\ObservableCallbackInterface;
use OpenTelemetry\API\Metrics\ObserverInterface;
use OpenTelemetry\API\Trace\Span;
use OpenTelemetry\API\Trace\SpanInterface;
use OpenTelemetry\API\Trace\SpanKind;
use OpenTelemetry\API\Trace\StatusCode;
use OpenTelemetry\API\Trace\TracerInterface;
use OpenTelemetry\API\Trace\TracerProviderInterface;

/**
 * OpenTelemetry for Keep Your Prompts (protocol/tracing.md): kyp.refresh spans with events,
 * kyp.* metrics and annotate(). Needs the open-telemetry/api package, which this SDK only
 * suggests: nothing here is loaded unless you use it.
 *
 *     $otel = Instrumentation::create();                       // global tracer/meter providers
 *     $prompts = new KeepYourPrompts(new Options(app: 'support-bot', observer: $otel));
 *     $otel->attach($prompts);                                 // or Instrumentation::instrument($prompts)
 *     $otel->annotate('triage');                               // kyp.* + gen_ai.prompt.* on the active span
 *
 * PRIVACY: with captureContent (or KYP_OTEL_CAPTURE_CONTENT=true) annotate() also records the
 * template and the variable values, which often hold personal data. Off by default.
 */
final class Instrumentation implements Observer
{
    /** Instrumentation scope (tracer and meter name), the same in every SDK. */
    public const SCOPE = 'keepyourprompts';
    /** Advice for kyp.refresh.duration (seconds). */
    public const REFRESH_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

    private ?KeepYourPrompts $client = null;
    private readonly TracerInterface $tracer;
    private readonly bool $capture;
    private ?HistogramInterface $duration = null;
    private ?CounterInterface $fallbacks = null;
    private ?CounterInterface $mismatches = null;
    private ?CounterInterface $renderErrors = null;
    private ?MeterProviderInterface $meterProvider;
    private ?ObservableCallbackInterface $gauges = null;
    /** @var (\Closure(): void)|null */
    private ?\Closure $unsubscribe = null;
    private bool $stopped = false;

    private function __construct(
        ?TracerProviderInterface $tracerProvider,
        ?MeterProviderInterface $meterProvider,
        ?bool $captureContent,
        private readonly bool $genAiAttributes,
        private readonly bool $openInference,
        private readonly bool $traceAllRefreshes,
    ) {
        $this->tracer = ($tracerProvider ?? Globals::tracerProvider())->getTracer(self::SCOPE, Options::VERSION);
        $this->capture = $captureContent ?? self::envCapture();
        $this->meterProvider = $meterProvider ?? Globals::meterProvider();
        $meter = $this->meterProvider->getMeter(self::SCOPE, Options::VERSION);
        $this->duration = $meter->createHistogram('kyp.refresh.duration', 's', 'Wall time of each prompt refresh round.', ['ExplicitBucketBoundaries' => self::REFRESH_BUCKETS]);
        $this->fallbacks = $meter->createCounter('kyp.fallbacks', '{fallback}', 'Mirror failures that made a refresh move on to the next mirror.');
        $this->mismatches = $meter->createCounter('kyp.hash_mismatches', '{blob}', 'Prompt bodies discarded because their SHA-256 did not match.');
        $this->renderErrors = $meter->createCounter('kyp.render.errors', '{error}', 'render() failures: unknown prompt or missing variable.');
    }

    /** True when the open-telemetry/api package is installed. */
    public static function available(): bool
    {
        return interface_exists(SpanInterface::class);
    }

    /**
     * An instrumentation not yet bound to a client: pass it as the `observer` option so the
     * start-up load is traced too, then call attach() with the client.
     */
    public static function create(
        ?TracerProviderInterface $tracerProvider = null,
        ?MeterProviderInterface $meterProvider = null,
        ?bool $captureContent = null,
        bool $genAiAttributes = true,
        bool $openInference = false,
        bool $traceAllRefreshes = false,
    ): self {
        if (!self::available()) {
            throw new KypException('kyp: the OpenTelemetry add-on needs open-telemetry/api (composer require open-telemetry/api)');
        }

        return new self($tracerProvider, $meterProvider, $captureContent, $genAiAttributes, $openInference, $traceAllRefreshes);
    }

    /**
     * Record kyp.refresh spans and kyp.* metrics for a client, and annotate LLM spans.
     */
    public static function instrument(
        KeepYourPrompts $client,
        ?TracerProviderInterface $tracerProvider = null,
        ?MeterProviderInterface $meterProvider = null,
        ?bool $captureContent = null,
        bool $genAiAttributes = true,
        bool $openInference = false,
        bool $traceAllRefreshes = false,
    ): self {
        return self::create($tracerProvider, $meterProvider, $captureContent, $genAiAttributes, $openInference, $traceAllRefreshes)->attach($client);
    }

    /**
     * Bind to a client: observe it (unless this is already its `observer` option), register
     * the kyp.staleness and kyp.revision gauges, and let annotate() take prompt names.
     */
    public function attach(KeepYourPrompts $client): self
    {
        if ($this->client !== null) {
            throw new KypException('kyp: this instrumentation is already attached to a client');
        }
        $this->client = $client;
        if ($client->options()->observer !== $this) {
            $this->unsubscribe = $client->addObserver($this);
        }
        $o = $client->options();
        $base = ['kyp.app' => $o->app, 'kyp.env' => $o->env];
        $meter = ($this->meterProvider ?? Globals::meterProvider())->getMeter(self::SCOPE, Options::VERSION);
        $staleness = $meter->createObservableGauge('kyp.staleness', 's', 'Seconds since a mirror last confirmed the prompts held.');
        $revision = $meter->createObservableGauge('kyp.revision', '{revision}', 'Manifest revision held (0 when nothing is loaded).');
        $this->gauges = $meter->batchObserve(
            static function (ObserverInterface $staleness, ObserverInterface $revision) use ($client, $base): void {
                try {
                    $s = $client->status();
                    $staleness->observe($s->staleFor, $base);
                    $revision->observe($s->revision, $base);
                } catch (\Throwable) {
                    // telemetry never breaks the app
                }
            },
            $staleness,
            $revision,
        );

        return $this;
    }

    /**
     * Annotate a span (default: the active one) with the prompt used: a name, PromptMeta or
     * Rendered. Returns the metadata. An unknown name throws NotFound like meta() does;
     * nothing else throws.
     *
     * @param array<string, mixed>|null $variables recorded only with content capture on
     */
    public function annotate(string|PromptMeta|Rendered $prompt, ?SpanInterface $span = null, ?array $variables = null, ?bool $captureContent = null): PromptMeta
    {
        if (is_string($prompt)) {
            if ($this->client === null) {
                throw new KypException('kyp: annotate(name) needs a client (Instrumentation::instrument or attach)');
            }
            $meta = $this->client->meta($prompt);
        } else {
            $meta = $prompt instanceof Rendered ? $prompt->meta : $prompt;
        }
        $capture = $captureContent ?? $this->capture;
        $template = null;
        if ($capture && $this->client !== null) {
            // Only the template of the very body the metadata names.
            try {
                $held = $this->client->has($meta->name) ? $this->client->prompt($meta->name) : null;
                $template = $held !== null && $held->sha256 === $meta->sha256 ? $held->text : null;
            } catch (\Throwable) {
            }
        }
        self::apply($meta, $span ?? Span::getCurrent(), $capture, $template, $variables, $this->genAiAttributes, $this->openInference);

        return $meta;
    }

    /**
     * Annotate a span (default: the active one) without a client. $template is recorded as
     * kyp.prompt.template only with content capture on.
     *
     * @param array<string, mixed>|null $variables
     */
    public static function annotateSpan(
        PromptMeta|Rendered $prompt,
        ?SpanInterface $span = null,
        ?array $variables = null,
        ?bool $captureContent = null,
        ?string $template = null,
        bool $genAiAttributes = true,
        bool $openInference = false,
    ): PromptMeta {
        $meta = $prompt instanceof Rendered ? $prompt->meta : $prompt;
        self::apply($meta, $span ?? Span::getCurrent(), $captureContent ?? self::envCapture(), $template, $variables, $genAiAttributes, $openInference);

        return $meta;
    }

    /** Stop recording spans and metrics for the client. */
    public function shutdown(): void
    {
        $this->stopped = true;
        if ($this->unsubscribe !== null) {
            ($this->unsubscribe)();
            $this->unsubscribe = null;
        }
        $this->gauges?->detach();
        $this->gauges = null;
    }

    public function onRefresh(RefreshRecord $rec): void
    {
        if ($this->stopped) {
            return;
        }
        try {
            $this->recordMetrics($rec);
            if ($rec->result === 'not_modified' && $rec->events === [] && !$this->traceAllRefreshes) {
                return;
            }
            $this->recordSpan($rec);
        } catch (\Throwable) {
            // telemetry never breaks the client
        }
    }

    public function onRenderError(RenderError $error): void
    {
        if ($this->stopped) {
            return;
        }
        try {
            $this->renderErrors?->add(1, ['kyp.app' => $error->app, 'kyp.env' => $error->env, 'kyp.prompt.name' => $error->name, 'error.type' => $error->errorType]);
        } catch (\Throwable) {
        }
    }

    // ---------------------------------------------------------------------------------

    private static function envCapture(): bool
    {
        $v = $_ENV['KYP_OTEL_CAPTURE_CONTENT'] ?? $_SERVER['KYP_OTEL_CAPTURE_CONTENT'] ?? getenv('KYP_OTEL_CAPTURE_CONTENT');

        return is_string($v) && in_array(strtolower(trim($v)), ['1', 'true', 'yes', 'on'], true);
    }

    /**
     * @param array<string, mixed>|null $variables
     */
    private static function apply(PromptMeta $meta, SpanInterface $span, bool $capture, ?string $template, ?array $variables, bool $genAi, bool $openInference): void
    {
        try {
            if (!$span->isRecording()) {
                return;
            }
            $a = $meta->attributes($genAi);
            if ($openInference) {
                $a['prompt.vendor'] = 'keepyourprompts';
                $a['prompt.id'] = $meta->app . '/' . $meta->env . '/' . $meta->name;
                $a['llm.prompt_template.version'] = (string) $meta->version;
            }
            if ($capture) {
                if ($template !== null) {
                    $a['kyp.prompt.template'] = $template;
                    if ($openInference) {
                        $a['llm.prompt_template.template'] = $template;
                    }
                }
                if ($variables !== null) {
                    $vars = [];
                    foreach ($variables as $k => $v) {
                        $vars[(string) $k] = self::stringify($v);
                        $a['gen_ai.prompt.variable.' . $k] = $vars[(string) $k];
                    }
                    if ($openInference) {
                        $a['llm.prompt_template.variables'] = (string) json_encode((object) $vars, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                    }
                }
            }
            $span->setAttributes($a);
        } catch (\Throwable) {
            // telemetry never breaks the app
        }
    }

    private static function stringify(mixed $v): string
    {
        return match (true) {
            is_string($v) => $v,
            $v === null => '',
            is_bool($v) => $v ? 'true' : 'false',
            is_scalar($v), $v instanceof \Stringable => (string) $v,
            default => (string) json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        };
    }

    private function recordMetrics(RefreshRecord $rec): void
    {
        $base = ['kyp.app' => $rec->app, 'kyp.env' => $rec->env];
        $attrs = $base + ['kyp.refresh.trigger' => $rec->trigger, 'kyp.refresh.result' => $rec->result];
        if ($rec->source !== '') {
            $attrs['kyp.source'] = $rec->source;
        }
        $this->duration?->record($rec->duration, $attrs);
        foreach ($rec->events as $e) {
            if ($e->name === 'kyp.fallback') {
                $this->fallbacks?->add(1, $base + [
                    'kyp.source' => $e->attributes['kyp.source'] ?? '',
                    'kyp.mirror' => $e->attributes['kyp.mirror'] ?? '',
                    'error.type' => $e->attributes['error.type'] ?? '_OTHER',
                ]);
            } elseif ($e->name === 'kyp.hash_mismatch') {
                $this->mismatches?->add(1, $base + [
                    'kyp.source' => $e->attributes['kyp.source'] ?? '',
                    'kyp.mirror' => $e->attributes['kyp.mirror'] ?? '',
                ]);
            }
        }
    }

    private function recordSpan(RefreshRecord $rec): void
    {
        $attrs = [
            'kyp.app' => $rec->app,
            'kyp.env' => $rec->env,
            'kyp.refresh.trigger' => $rec->trigger,
            'kyp.refresh.result' => $rec->result,
        ];
        if ($rec->revision > 0) {
            $attrs['kyp.revision'] = $rec->revision;
        }
        if ($rec->workspace !== '') {
            $attrs['kyp.workspace'] = $rec->workspace;
        }
        if ($rec->source !== '') {
            $attrs['kyp.source'] = $rec->source;
            $attrs['kyp.mirror'] = $rec->mirror;
        }
        if ($rec->result === 'failed') {
            $attrs['error.type'] = $rec->errorType !== '' ? $rec->errorType : '_OTHER';
        }
        $start = (int) round($rec->startTime * 1e9);
        $span = $this->tracer->spanBuilder('kyp.refresh')
            ->setSpanKind(SpanKind::KIND_INTERNAL)
            // A manual refresh is a child of the caller's active span; start-up and polls are roots.
            ->setParent($rec->trigger === 'manual' ? null : false)
            ->setStartTimestamp($start)
            ->setAttributes($attrs)
            ->startSpan();
        foreach ($rec->events as $e) {
            $span->addEvent($e->name, $e->attributes, (int) round($e->time * 1e9));
        }
        if ($rec->result === 'failed') {
            $span->setStatus(StatusCode::STATUS_ERROR, substr($rec->error, 0, 500));
        }
        $span->end($start + (int) round($rec->duration * 1e9));
    }
}
