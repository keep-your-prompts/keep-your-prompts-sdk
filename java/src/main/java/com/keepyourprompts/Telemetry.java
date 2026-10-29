package com.keepyourprompts;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Delivery telemetry types and helpers (protocol/tracing.md). No dependency on OpenTelemetry: the
 * {@code com.keepyourprompts.otel} package builds on these.
 */
public final class Telemetry {
  private Telemetry() {}

  /** A span event recorded during a refresh round: {@code kyp.fallback}, {@code kyp.hash_mismatch} or {@code kyp.update}. */
  public record Event(String name, Instant time, Map<String, Object> attributes) {
    public Event {
      attributes = Map.copyOf(attributes);
    }
  }

  /**
   * One refresh round, passed to {@link Observer#onRefresh}.
   *
   * @param trigger {@code start}, {@code poll} or {@code manual}
   * @param result {@code updated}, {@code not_modified} or {@code failed}
   * @param mirror configured name of the mirror that answered (empty when failed)
   * @param source its normalised kind
   * @param error when failed: short message, delivery key redacted
   * @param errorType when failed: low-cardinality {@code error.type}
   */
  public record RefreshRecord(
      String app,
      String env,
      String trigger,
      String result,
      Instant start,
      Duration duration,
      String mirror,
      String source,
      long revision,
      long previousRevision,
      String workspace,
      String error,
      String errorType,
      List<Event> events) {
    public RefreshRecord {
      events = List.copyOf(events);
    }
  }

  /** A failed {@code render}: {@code errorType} is {@code not_found} or {@code missing_variable}. */
  public record RenderError(String app, String env, String name, String errorType) {}

  /** Receives delivery telemetry. Exceptions are caught and logged; they never break the client. */
  public interface Observer {
    default void onRefresh(RefreshRecord record) {}

    default void onRenderError(RenderError error) {}
  }

  private static final Pattern BLOB_UNAVAILABLE = Pattern.compile("blob \\S+ unavailable");
  private static final Pattern HTTP_NOT_FOUND = Pattern.compile("http (404|410)\\b");
  private static final Pattern HTTP = Pattern.compile("http (\\d{3})\\b");
  private static final Pattern NETWORK =
      Pattern.compile("connect|connection|network|socket|unknownhost|unresolved|refused|unreachable|eof|closed");

  /** Maps a failure message to a low-cardinality {@code error.type}. */
  public static String classifyError(String message) {
    String m = message == null ? "" : message.toLowerCase(Locale.ROOT);
    if (BLOB_UNAVAILABLE.matcher(m).find()) return "blob_unavailable";
    if (m.contains("sha256 verification") || m.contains("hash mismatch")) return "hash_mismatch";
    if (m.contains("stale manifest")) return "stale";
    if (m.contains("bad manifest") || m.contains("invalid manifest")) return "bad_manifest";
    if (HTTP_NOT_FOUND.matcher(m).find()
        || m.contains("not found")
        || m.contains("no such file")
        || m.contains("nosuchfile")
        || m.equals("empty")) return "not_found";
    Matcher h = HTTP.matcher(m);
    if (h.find()) return "http_" + h.group(1);
    if (m.contains("timeout") || m.contains("timed out") || m.contains("deadline")) return "timeout";
    if (NETWORK.matcher(m).find()) return "network";
    return "_OTHER";
  }

  /** Maps a mirror to its {@code kyp.source} value. */
  public static String normalizeSource(Mirror m) {
    String name = m.name();
    switch (name) {
      case "":
        return "";
      case "disk-cache":
        return "cache";
      case "embedded":
      case "snapshot":
      case "cache":
      case "cdn":
      case "origin":
      case "git":
        return name;
      default:
        break;
    }
    switch (Transport.kindOf(m.url())) {
      case CLASSPATH:
        return "embedded";
      case FILE:
        return "snapshot";
      case CACHE:
        return "cache";
      default:
        return "custom";
    }
  }
}
