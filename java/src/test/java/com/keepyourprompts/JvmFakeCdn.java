package com.keepyourprompts;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** In-JVM port of conformance/fake_cdn.py on com.sun.net.httpserver: always available. */
final class JvmFakeCdn implements FakeCdn {
  static final String MANIFEST_CC = "public, max-age=15, stale-while-revalidate=300, stale-if-error=86400";
  static final String BLOB_CC = "public, max-age=31536000, immutable";

  private record Route(String name, String prefix, Path dir) {}

  private final HttpServer server;
  private final ExecutorService pool = Executors.newCachedThreadPool(r -> {
    Thread t = new Thread(r, "fake-cdn");
    t.setDaemon(true);
    return t;
  });
  private final List<Route> routes;
  private final Map<String, Map<String, Integer>> stats = new HashMap<>();
  private final Map<String, String> auth = new HashMap<>();
  private final Set<String> downRoutes = new HashSet<>();

  JvmFakeCdn(Map<String, Map.Entry<String, Path>> routeMap) throws IOException {
    routes = routeMap.entrySet().stream()
        .map(e -> new Route(e.getKey(), e.getValue().getKey().replaceAll("/+$", ""), e.getValue().getValue()))
        .toList();
    for (Route r : routes) {
      Map<String, Integer> s = new LinkedHashMap<>();
      for (String k : new String[] {"200", "304", "404", "503"}) s.put(k, 0);
      stats.put(r.name(), s);
    }
    server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
    server.setExecutor(pool);
    server.createContext("/", this::handle);
    server.start();
  }

  static FakeCdn.Factory factory() {
    return JvmFakeCdn::new;
  }

  @Override
  public String base() {
    return "http://127.0.0.1:" + server.getAddress().getPort();
  }

  @Override
  public synchronized void down(String route) {
    downRoutes.add(route);
  }

  @Override
  public synchronized void up(String route) {
    downRoutes.remove(route);
  }

  @Override
  public synchronized int stat(String route, String key) {
    return stats.get(route).get(key);
  }

  @Override
  public synchronized String auth(String route) {
    return auth.get(route);
  }

  @Override
  public void close() {
    server.stop(0);
    pool.shutdownNow();
  }

  private static void send(HttpExchange ex, int code, byte[] body, Map<String, String> headers) throws IOException {
    headers.forEach((k, v) -> ex.getResponseHeaders().set(k, v));
    boolean noBody = code == 304 || ex.getRequestMethod().equals("HEAD");
    ex.sendResponseHeaders(code, noBody ? -1 : body.length == 0 ? -1 : body.length);
    if (!noBody && body.length > 0) {
      try (OutputStream os = ex.getResponseBody()) {
        os.write(body);
      }
    }
    ex.close();
  }

  private void handle(HttpExchange ex) throws IOException {
    String path = ex.getRequestURI().getRawPath();
    for (Route r : routes) {
      if (path.startsWith(r.prefix() + "/")) {
        serve(ex, r, path.substring(r.prefix().length() + 1));
        return;
      }
    }
    send(ex, 404, "no route".getBytes(), Map.of());
  }

  private void serve(HttpExchange ex, Route r, String rel) throws IOException {
    synchronized (this) {
      auth.put(r.name(), ex.getRequestHeaders().getFirst("Authorization"));
      if (downRoutes.contains(r.name())) {
        stats.get(r.name()).merge("503", 1, Integer::sum);
        send(ex, 503, "down".getBytes(), Map.of());
        return;
      }
    }
    List<String> parts = Arrays.asList(rel.split("/", -1));
    if (parts.contains("..") || parts.contains("") || !(rel.startsWith("envs/") || rel.startsWith("blobs/"))) {
      send(ex, 404, "not found".getBytes(), Map.of());
      return;
    }
    Path file = r.dir().resolve(rel);
    if (!Files.isRegularFile(file)) {
      synchronized (this) {
        stats.get(r.name()).merge("404", 1, Integer::sum);
      }
      send(ex, 404, "not found".getBytes(), Map.of());
      return;
    }
    byte[] body = Files.readAllBytes(file);
    String etag = "\"" + Templates.sha256Hex(body).substring(0, 32) + "\"";
    Map<String, String> headers = new LinkedHashMap<>();
    headers.put("ETag", etag);
    headers.put("Cache-Control", rel.startsWith("envs/") ? MANIFEST_CC : BLOB_CC);
    headers.put("Content-Type", rel.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8");
    if (etag.equals(ex.getRequestHeaders().getFirst("If-None-Match"))) {
      synchronized (this) {
        stats.get(r.name()).merge("304", 1, Integer::sum);
      }
      send(ex, 304, new byte[0], headers);
      return;
    }
    synchronized (this) {
      stats.get(r.name()).merge("200", 1, Integer::sum);
    }
    send(ex, 200, body, headers);
  }
}
