<?php

declare(strict_types=1);

namespace KeepYourPrompts;

/**
 * Which deployed body a call used (protocol/tracing.md, "Prompt metadata"). Read from memory
 * with KeepYourPrompts::meta() or renderWithMeta(); no dependency on OpenTelemetry or any vendor SDK.
 *
 *     $meta = $prompts->meta('triage');
 *     $span->setAttributes($meta->attributes());           // kyp.* + gen_ai.prompt.*
 *     $langfuseMetadata = $meta->langfuseMetadata();       // flat kyp_* keys
 */
final class PromptMeta
{
    public function __construct(
        public readonly string $name,
        public readonly int $version,
        public readonly string $sha256,
        public readonly string $app,
        public readonly string $env,
        public readonly string $workspace,
        public readonly int $revision,
        /** Normalised mirror kind (embedded, snapshot, cache, cdn, origin, git, custom); '' before anything is loaded. */
        public readonly string $source,
    ) {
    }

    /**
     * Span attributes: kyp.* plus gen_ai.prompt.name / gen_ai.prompt.version (a string) unless
     * $genAi is false. kyp.workspace and kyp.source are left out when empty. No content, ever.
     *
     * @return array<string, string|int>
     */
    public function attributes(bool $genAi = true): array
    {
        $a = [
            'kyp.prompt.name' => $this->name,
            'kyp.prompt.version' => $this->version,
            'kyp.prompt.sha256' => $this->sha256,
            'kyp.app' => $this->app,
            'kyp.env' => $this->env,
            'kyp.revision' => $this->revision,
        ];
        if ($this->workspace !== '') {
            $a['kyp.workspace'] = $this->workspace;
        }
        if ($this->source !== '') {
            $a['kyp.source'] = $this->source;
        }
        if ($genAi) {
            $a['gen_ai.prompt.name'] = $this->name;
            $a['gen_ai.prompt.version'] = (string) $this->version;
        }

        return $a;
    }

    /**
     * Flat kyp_* keys (dots replaced by underscores), for any tool's free-form metadata.
     *
     * @return array<string, string|int>
     */
    public function traceMetadata(): array
    {
        $out = [];
        foreach ($this->attributes(false) as $k => $v) {
            $out[str_replace('.', '_', $k)] = $v;
        }

        return $out;
    }

    /**
     * The same map, for the metadata of a Langfuse observation.
     *
     * @return array<string, string|int>
     */
    public function langfuseMetadata(): array
    {
        return $this->traceMetadata();
    }

    /**
     * The same map, for LangSmith run metadata.
     *
     * @return array<string, string|int>
     */
    public function langsmithMetadata(): array
    {
        return $this->traceMetadata();
    }
}
