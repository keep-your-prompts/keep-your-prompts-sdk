package com.keepyourprompts;

import java.time.Instant;

/**
 * Health of one mirror, part of {@link Status}.
 *
 * @param name e.g. {@code cdn}
 * @param url base URL with the delivery key shortened
 * @param consecutiveFailures failures since the last success
 * @param lastError latest error, empty when healthy
 * @param lastSuccess last time it answered, or {@code null}
 */
public record MirrorStatus(String name, String url, int consecutiveFailures, String lastError, Instant lastSuccess) {}
