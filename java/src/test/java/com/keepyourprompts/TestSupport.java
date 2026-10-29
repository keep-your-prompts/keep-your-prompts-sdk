package com.keepyourprompts;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.Map;
import java.util.function.BooleanSupplier;
import java.util.stream.Stream;

/** Shared helpers: the conformance folder, fixture deployment and polling. */
final class TestSupport {
  private TestSupport() {}

  static Path conformanceDir() {
    String p = System.getProperty("kyp.conformance.dir");
    Path dir = p != null ? Paths.get(p) : Paths.get("..", "conformance");
    return dir.toAbsolutePath().normalize();
  }

  static Path fixture(String name) {
    return conformanceDir().resolve("fixtures").resolve(name);
  }

  @SuppressWarnings("unchecked")
  static Map<String, Object> cases() throws IOException {
    return (Map<String, Object>) Json.parse(Files.readString(conformanceDir().resolve("cases.json")));
  }

  /** Deploy like the server does: blobs first, then the manifest by rename. */
  static void deploy(String fixture, Path dir) {
    Path src = fixture(fixture);
    try {
      Files.createDirectories(dir.resolve("blobs"));
      try (Stream<Path> blobs = Files.list(src.resolve("blobs"))) {
        for (Path b : (Iterable<Path>) blobs::iterator)
          Files.copy(b, dir.resolve("blobs").resolve(b.getFileName().toString()), StandardCopyOption.REPLACE_EXISTING);
      }
      Path envDir = dir.resolve("envs").resolve("demo");
      Files.createDirectories(envDir);
      Path tmp = envDir.resolve("prod.json.new");
      Files.copy(src.resolve("envs/demo/prod.json"), tmp, StandardCopyOption.REPLACE_EXISTING);
      Files.move(tmp, envDir.resolve("prod.json"), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  static boolean eventually(BooleanSupplier cond, Duration timeout) throws InterruptedException {
    long end = System.nanoTime() + timeout.toNanos();
    while (System.nanoTime() < end) {
      if (cond.getAsBoolean()) return true;
      Thread.sleep(20);
    }
    return cond.getAsBoolean();
  }

  static KeepYourPrompts.Builder quiet() {
    return KeepYourPrompts.builder().app("demo").env("prod").logLevel(LogLevel.OFF);
  }

  static final String GREETING_V4 = "Hello {{name}}, welcome to {{ company }}.";
  static final String GREETING_V5 = "Hi {{name}}! {{company}} is glad you are here.";
}
