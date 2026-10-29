package com.keepyourprompts;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * Client health, for logs, metrics and readiness probes.
 *
 * @param ready a manifest is loaded
 * @param source mirror that served or last confirmed the current state: {@code embedded}, {@code snapshot},
 *     {@code disk-cache}, {@code cdn}, {@code origin}, {@code git} (or a custom mirror name)
 * @param revision manifest revision, 0 when nothing is loaded
 * @param workspace workspace slug from the manifest
 * @param deployedAt {@code deployed_at} from the manifest
 * @param promptCount number of prompts
 * @param lastSuccess last time a polled mirror confirmed the manifest (200 or 304), or {@code null}
 * @param lastError failures in the latest round, e.g. {@code cdn: HTTP 503}; empty when the first mirror answered
 * @param staleFor time since {@code lastSuccess} (since start-up if never): alert on this
 * @param mirrors per-mirror health
 */
public record Status(
    boolean ready,
    String source,
    long revision,
    String workspace,
    String deployedAt,
    int promptCount,
    Instant lastSuccess,
    String lastError,
    Duration staleFor,
    List<MirrorStatus> mirrors) {
  public Status {
    mirrors = List.copyOf(mirrors);
  }
}
