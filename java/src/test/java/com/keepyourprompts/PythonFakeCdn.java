package com.keepyourprompts;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/** Runs conformance/fake_cdn.py as a child process. */
final class PythonFakeCdn implements FakeCdn {
  private final Process process;
  private final int port;
  private final HttpClient http = HttpClient.newBuilder().proxy(HttpClient.Builder.NO_PROXY).build();

  static String python() {
    for (String candidate : new String[] {"python3", "python"}) {
      try {
        Process p = new ProcessBuilder(candidate, "-c", "import sys; assert sys.version_info >= (3, 7)")
            .redirectErrorStream(true)
            .start();
        p.getInputStream().readAllBytes();
        if (p.waitFor(10, TimeUnit.SECONDS) && p.exitValue() == 0) return candidate;
      } catch (IOException | InterruptedException ignored) {
        // try the next one
      }
    }
    return null;
  }

  PythonFakeCdn(String python, Map<String, Map.Entry<String, Path>> routes) throws IOException {
    List<String> cmd = new ArrayList<>(List.of(python, TestSupport.conformanceDir().resolve("fake_cdn.py").toString()));
    routes.forEach((name, e) -> {
      cmd.add("--route");
      cmd.add(name + ":" + e.getKey() + ":" + e.getValue());
    });
    process = new ProcessBuilder(cmd).redirectError(ProcessBuilder.Redirect.INHERIT).start();
    BufferedReader r = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
    String line = r.readLine();
    if (line == null || !line.startsWith("PORT ")) {
      process.destroyForcibly();
      throw new IOException("fake_cdn.py did not start: " + line);
    }
    port = Integer.parseInt(line.substring(5).trim());
  }

  @Override
  public String base() {
    return "http://127.0.0.1:" + port;
  }

  private String ctl(String path) {
    try {
      return http.send(
              HttpRequest.newBuilder(URI.create(base() + path)).timeout(Duration.ofSeconds(5)).build(),
              HttpResponse.BodyHandlers.ofString())
          .body();
    } catch (IOException e) {
      throw new RuntimeException(e);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new RuntimeException(e);
    }
  }

  @Override
  public void down(String route) {
    ctl("/__down/" + route);
  }

  @Override
  public void up(String route) {
    ctl("/__up/" + route);
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> stats(String route) {
    return (Map<String, Object>) ((Map<String, Object>) Json.parse(ctl("/__stats"))).get(route);
  }

  @Override
  public int stat(String route, String key) {
    return ((Long) stats(route).get(key)).intValue();
  }

  @Override
  public String auth(String route) {
    return (String) stats(route).get("auth");
  }

  @Override
  public void close() {
    process.destroy();
    try {
      if (!process.waitFor(5, TimeUnit.SECONDS)) process.destroyForcibly();
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      process.destroyForcibly();
    }
  }
}
