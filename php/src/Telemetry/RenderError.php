<?php

declare(strict_types=1);

namespace KeepYourPrompts\Telemetry;

/**
 * A failed render() or renderWithMeta(), passed to Observer::onRenderError().
 */
final class RenderError
{
    /**
     * @param 'not_found'|'missing_variable' $errorType
     */
    public function __construct(
        public readonly string $app,
        public readonly string $env,
        public readonly string $name,
        public readonly string $errorType,
    ) {
    }
}
