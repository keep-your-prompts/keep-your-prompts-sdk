<?php

declare(strict_types=1);

namespace KeepYourPrompts\Telemetry;

/**
 * Receives delivery telemetry (protocol/tracing.md, "SDK architecture"). Register one with the
 * `observer` option or KeepYourPrompts::addObserver(). Called outside the store lock; an
 * observer that throws is logged and ignored.
 */
interface Observer
{
    /** After each refresh round (start-up load, due revalidation, manual refresh()). */
    public function onRefresh(RefreshRecord $record): void;

    /** When render() or renderWithMeta() fails. */
    public function onRenderError(RenderError $error): void;
}
