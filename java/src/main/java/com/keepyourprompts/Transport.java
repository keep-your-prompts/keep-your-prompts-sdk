package com.keepyourprompts;

import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicLong;

/** Mirror transports: files, class-path resources and HTTP(S). */
final class Transport {
  private Transport() {}

  static final int MAX_BODY = 16 << 20; // 16 MiB: far above any manifest or prompt

  enum Kind {
    OK,
    NOT_MODIFIED,
    NOT_FOUND,
    FAILED
  }

  record Result(Kind kind, byte[] body, String etag, String error) {
    static Result ok(byte[] body, String etag) {
      return new Result(Kind.OK, body, etag, "");
    }

    static Result notFound(String error) {
      return new Result(Kind.NOT_FOUND, null, "", error);
    }

    static Result failed(String error) {
      return new Result(Kind.FAILED, null, "", error);
    }
  }

  enum MirrorKind {
    CLASSPATH,
    FILE,
    CACHE,
    HTTP
  }

  static MirrorKind kindOf(String url) {
    if (url.startsWith("classpath:")) return MirrorKind.CLASSPATH;
    if (url.startsWith("http://") || url.startsWith("https://")) return MirrorKind.HTTP;
    return MirrorKind.FILE;
  }

  static Path fileUrlToPath(String url) {
    if (url.startsWith("file:")) return Paths.get(URI.create(url));
    return Paths.get(url);
  }

  static String joinUrl(String base, String rel) {
    return base.endsWith("/") ? base + rel : base + "/" + rel;
  }

  static Result readFile(Path path) {
    try {
      return Result.ok(Files.readAllBytes(path), "");
    } catch (NoSuchFileException e) {
      return Result.notFound("no such file: " + path);
    } catch (IOException e) {
      return Files.exists(path)
          ? Result.failed("cannot read " + path + ": " + e.getMessage())
          : Result.notFound("no such file: " + path);
    }
  }

  static Result readResource(ClassLoader loader, String prefix, String rel) {
    String name = prefix.isEmpty() ? rel : (prefix.endsWith("/") ? prefix + rel : prefix + "/" + rel);
    if (name.startsWith("/")) name = name.substring(1);
    try (InputStream in = loader.getResourceAsStream(name)) {
      if (in == null) return Result.notFound("no such resource: " + name);
      return Result.ok(in.readAllBytes(), "");
    } catch (IOException e) {
      return Result.failed("cannot read resource " + name + ": " + e.getMessage());
    }
  }

  /** Strict UTF-8 decoding: a blob that is not UTF-8 is a protocol error. */
  static String utf8(byte[] data) throws CharacterCodingException {
    return StandardCharsets.UTF_8
        .newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(data))
        .toString();
  }

  private static final AtomicLong COUNTER = new AtomicLong();

  /** Write a temp file, fsync, then rename over {@code path}. */
  static void atomicWrite(Path path, byte[] data) throws IOException {
    Path dir = path.toAbsolutePath().getParent();
    Files.createDirectories(dir);
    Path tmp =
        dir.resolve(
            path.getFileName() + ".tmp-" + Long.toUnsignedString(ThreadLocalRandom.current().nextLong(), 36) + "-"
                + COUNTER.incrementAndGet());
    try {
      try (FileChannel ch =
          FileChannel.open(tmp, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
        ByteBuffer buf = ByteBuffer.wrap(data);
        while (buf.hasRemaining()) ch.write(buf);
        ch.force(true);
      }
      try {
        Files.move(tmp, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
      } catch (AtomicMoveNotSupportedException e) {
        Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING);
      }
    } finally {
      Files.deleteIfExists(tmp);
    }
  }

  /** One HTTP client per SDK client: connection reuse (keep-alive, HTTP/2 over TLS), system proxy. */
  static final class Http {
    private final HttpClient client;
    private final Duration requestTimeout;
    private final String userAgent;

    Http(Duration connectTimeout, Duration requestTimeout, String userAgent) {
      HttpClient.Builder b =
          HttpClient.newBuilder()
              .connectTimeout(connectTimeout)
              .followRedirects(HttpClient.Redirect.NORMAL);
      ProxySelector ps = ProxySelector.getDefault();
      if (ps != null) b.proxy(ps);
      this.client = b.build();
      this.requestTimeout = requestTimeout;
      this.userAgent = userAgent;
    }

    /**
     * GET with optional {@code If-None-Match} and bearer token. {@code deadlineNanos} (from
     * {@link System#nanoTime()}) bounds the whole request; {@link Long#MAX_VALUE} means only the request timeout.
     */
    Result get(String url, String ifNoneMatch, String bearer, long deadlineNanos) {
      Duration timeout = requestTimeout;
      if (deadlineNanos != Long.MAX_VALUE) {
        long left = deadlineNanos - System.nanoTime();
        if (left <= 0) return Result.failed("timed out");
        if (left < timeout.toNanos()) timeout = Duration.ofNanos(left);
      }
      HttpRequest.Builder rb;
      try {
        rb = HttpRequest.newBuilder(URI.create(url)).timeout(timeout).GET();
      } catch (IllegalArgumentException e) {
        return Result.failed("invalid URL: " + e.getMessage());
      }
      if (url.startsWith("http://")) rb.version(HttpClient.Version.HTTP_1_1); // no h2c upgrade dance
      rb.header("User-Agent", userAgent);
      rb.header("Accept", "*/*");
      if (ifNoneMatch != null && !ifNoneMatch.isEmpty()) rb.header("If-None-Match", ifNoneMatch);
      if (bearer != null && !bearer.isEmpty()) rb.header("Authorization", "Bearer " + bearer);
      HttpResponse<InputStream> resp;
      try {
        resp = client.send(rb.build(), HttpResponse.BodyHandlers.ofInputStream());
      } catch (HttpConnectTimeoutException e) {
        return Result.failed("connect timed out");
      } catch (HttpTimeoutException e) {
        return Result.failed("timed out");
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        return Result.failed("interrupted");
      } catch (InterruptedIOException e) {
        return Result.failed("interrupted");
      } catch (IOException e) {
        String m = e.getMessage();
        return Result.failed(e.getClass().getSimpleName() + (m == null || m.isEmpty() ? "" : ": " + m));
      } catch (RuntimeException e) {
        return Result.failed(e.toString());
      }
      int code = resp.statusCode();
      String etag = resp.headers().firstValue("ETag").orElse("");
      try (InputStream in = resp.body()) {
        if (code == 304) return new Result(Kind.NOT_MODIFIED, null, etag, "");
        if (code == 404 || code == 410) return Result.notFound("HTTP " + code);
        if (code < 200 || code >= 300) return Result.failed("HTTP " + code);
        byte[] body = in.readNBytes(MAX_BODY + 1);
        if (body.length > MAX_BODY) return Result.failed("response larger than 16 MiB");
        return Result.ok(body, etag);
      } catch (IOException e) {
        return Result.failed("read failed: " + e.getMessage());
      }
    }
  }
}
