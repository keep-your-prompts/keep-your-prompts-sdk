package com.keepyourprompts.springai;

import com.keepyourprompts.KeepYourPrompts;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.stream.Stream;

/** Real core-SDK clients over the shared conformance fixtures: no network, no fakes. */
final class Fixtures {
  static final Path DIR = Path.of(System.getProperty("kyp.conformance.dir", "../../conformance")).resolve("fixtures");

  private Fixtures() {}

  static KeepYourPrompts client(Path snapshot) {
    return KeepYourPrompts.builder().app("demo").snapshotDir(snapshot).pollInterval(Duration.ofHours(1)).build();
  }

  static KeepYourPrompts v12() {
    return client(DIR.resolve("v12"));
  }

  /** Copies fixture {@code from} over {@code dir} (a deploy, for the next {@code refresh()}). */
  static void deploy(String from, Path dir) {
    Path src = DIR.resolve(from);
    try (Stream<Path> files = Files.walk(src)) {
      for (Path f : (Iterable<Path>) files::iterator) {
        Path to = dir.resolve(src.relativize(f).toString());
        if (Files.isDirectory(f)) Files.createDirectories(to);
        else Files.copy(f, to, StandardCopyOption.REPLACE_EXISTING);
      }
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }
}
