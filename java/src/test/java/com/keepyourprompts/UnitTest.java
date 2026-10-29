package com.keepyourprompts;

import static com.keepyourprompts.TestSupport.GREETING_V4;
import static com.keepyourprompts.TestSupport.GREETING_V5;
import static com.keepyourprompts.TestSupport.deploy;
import static com.keepyourprompts.TestSupport.fixture;
import static com.keepyourprompts.TestSupport.quiet;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class UnitTest {
  @TempDir Path tmp;

  @Test
  @DisplayName("5. start from local: snapshot folder, no network, greeting v4 at once")
  void startFromSnapshot() {
    long t0 = System.nanoTime();
    try (KeepYourPrompts c = quiet().snapshotDir(fixture("v12")).build()) {
      assertTrue((System.nanoTime() - t0) / 1_000_000 < 1000);
      Prompt p = c.prompt("greeting");
      assertEquals(4, p.version());
      assertEquals(GREETING_V4, p.text());
      assertEquals(List.of("name", "company"), p.variables());
      assertEquals("Hello Ana, welcome to Acme.", c.render("greeting", Map.of("name", "Ana", "company", "Acme")));
      assertEquals("snapshot", c.status().source());
      assertEquals(List.of("agents/reviewer", "empty", "greeting", "triage"), c.names());
      assertEquals("Review the diff.", c.get("agents/reviewer"));
      assertEquals("", c.get("empty"));
      assertEquals("You are a support agent for Acme. Literal {{braces}} stay.",
          c.render("triage", Map.of("company", "Acme")));
      assertEquals("acme", c.status().workspace());
    }
  }

  @Test
  @DisplayName("4. hash check: a tampered snapshot is refused")
  void tamperedSnapshot() {
    UnavailableException e = assertThrows(UnavailableException.class,
        () -> quiet().snapshotDir(fixture("tampered-v14")).startupTimeout(Duration.ofMillis(200)).build());
    assertTrue(e.getMessage().contains("sha256"), e.getMessage());
  }

  @Test
  @DisplayName("9. stale local copies: highest revision wins at start-up")
  void highestLocalRevisionWins() {
    Path cache = tmp.resolve("cache");
    try (KeepYourPrompts c = quiet().snapshotDir(fixture("v13")).cacheDir(cache).build()) {
      assertEquals(13, c.revision());
    }
    try (KeepYourPrompts c = quiet().snapshotDir(fixture("v11-stale")).cacheDir(cache).build()) {
      assertEquals(13, c.revision());
      assertEquals("disk-cache", c.status().source());
    }
  }

  @Test
  @DisplayName("snapshot folder kept fresh by a sidecar is picked up live")
  void pollsSnapshotFolder() throws Exception {
    Path dir = tmp.resolve("snap");
    deploy("v12", dir);
    List<Update> updates = new CopyOnWriteArrayList<>();
    try (KeepYourPrompts c = quiet().snapshotDir(dir).pollInterval(Duration.ofMillis(100)).onUpdate(updates::add).build()) {
      deploy("v13", dir);
      assertTrue(TestSupport.eventually(() -> c.revision() == 13, Duration.ofSeconds(5)));
      assertEquals(GREETING_V5, c.get("greeting"));
      assertTrue(TestSupport.eventually(() -> updates.size() == 1, Duration.ofSeconds(2)));
    }
  }

  @Test
  @DisplayName("class-path snapshot: fat jars start with zero network")
  void classpathSnapshot() throws Exception {
    Path root = tmp.resolve("cp");
    deploy("v12", root.resolve("prompts"));
    try (URLClassLoader cl = new URLClassLoader(new URL[] {root.toUri().toURL()}, null);
        KeepYourPrompts c = quiet().snapshotFromClasspath("prompts", cl).build()) {
      assertEquals("embedded", c.status().source());
      assertEquals(GREETING_V4, c.get("greeting"));
    }
  }

  @Test
  @DisplayName("KYP_* environment variables")
  void fromEnvironment() {
    Map<String, String> env = new HashMap<>();
    env.put("KYP_APP", "demo");
    env.put("KYP_ENV", "prod");
    env.put("KYP_SNAPSHOT_DIR", fixture("v12").toString());
    env.put("KYP_POLL_INTERVAL", "0.5");
    env.put("KYP_LOG", "off");
    KeepYourPrompts.Builder b = KeepYourPrompts.Builder.fromEnvironment(env::get);
    assertEquals(Duration.ofMillis(500), b.pollInterval);
    assertEquals(LogLevel.OFF, b.logLevel);
    try (KeepYourPrompts c = b.build()) {
      assertEquals(12, c.revision());
    }
    env.put("KYP_SNAPSHOT_DIR", "classpath:prompts");
    env.put("KYP_DELIVERY_KEY", "kypd_x");
    env.put("KYP_GIT_MIRROR", "https://raw.githubusercontent.com/acme/prompts/main/.kyp");
    env.put("KYP_GIT_TOKEN", "t");
    b = KeepYourPrompts.Builder.fromEnvironment(env::get);
    assertEquals("prompts", b.classpathPrefix);
    assertEquals("kypd_x", b.deliveryKey);
    assertEquals("t", b.gitToken);
  }

  @Test
  @DisplayName("errors: not found, missing variables, bad options, nothing configured")
  void errors() {
    try (KeepYourPrompts c = quiet().snapshotDir(fixture("v12")).build()) {
      PromptNotFoundException nf = assertThrows(PromptNotFoundException.class, () -> c.get("nope"));
      assertEquals("nope", nf.name());
      assertTrue(c.tryGet("nope").isEmpty());
      assertFalse(c.contains("nope"));
      MissingVariableException mv = assertThrows(MissingVariableException.class, () -> c.render("greeting", Map.of()));
      assertEquals(List.of("name", "company"), mv.names());
      assertEquals("Hello {{name}}, welcome to {{ company }}.", c.render("greeting", Map.of(), OnMissing.KEEP));
      assertEquals("Hello , welcome to .", c.render("greeting", Map.of(), OnMissing.EMPTY));
      assertEquals("Hello 7, welcome to Acme.", c.render("greeting", Map.of("name", 7, "company", "Acme")));
    }
    assertThrows(KypException.class, () -> KeepYourPrompts.builder().build());
    assertThrows(KypException.class, () -> KeepYourPrompts.builder().app("Bad App").build());
    assertThrows(KypException.class, () -> quiet().deliveryKey("kypd_bad/key").build());
    assertThrows(UnavailableException.class, () -> quiet().build());
    try (KeepYourPrompts empty = quiet().startEmpty(true).build()) {
      assertFalse(empty.status().ready());
      assertEquals(0, empty.revision());
      assertFalse(empty.refresh());
    }
  }

  @Test
  @DisplayName("manifest for another app/env is rejected")
  void wrongApp() throws Exception {
    String text = Files.readString(fixture("v12").resolve("envs/demo/prod.json"));
    assertThrows(ProtocolException.class, () -> Manifest.parse(text, "other", "prod"));
    assertThrows(ProtocolException.class, () -> Manifest.parse(text, "demo", "staging"));
    assertThrows(ProtocolException.class, () -> Manifest.parse("[]", "demo", "prod"));
    assertThrows(ProtocolException.class, () -> Manifest.parse("{", "demo", "prod"));
  }

  @Test
  @DisplayName("pullSnapshot writes a complete mirror")
  void pullSnapshot() throws Exception {
    Path out = tmp.resolve("out");
    try (JvmFakeCdn s = new JvmFakeCdn(Map.of("cdn", Map.entry("/v1/d/kypd_test", fixture("v13"))))) {
      KeepYourPrompts.SnapshotInfo info = KeepYourPrompts.pullSnapshot(
          quiet().deliveryKey("kypd_test").cdnBase(s.base() + "/v1/d").originBase(s.base() + "/none"), out);
      assertEquals(13, info.revision());
      assertEquals(4, info.blobsWritten());
      assertEquals("cdn", info.source());
    }
    try (KeepYourPrompts c = quiet().snapshotDir(out).build()) {
      assertEquals(GREETING_V5, c.get("greeting"));
    }
  }

  @Test
  @DisplayName("JSON parser")
  void json() {
    assertEquals(Map.of("a", List.of(1L, 2.5, true, "x\n\u00e9")),
        Json.parse("{\"a\":[1, 2.5, true, \"x\\n\\u00e9\"]}"));
    assertInstanceOf(BigInteger.class, Json.parse("123456789012345678901234567890"));
    assertEquals(-0L, Json.parse("-0"));
    for (String bad : new String[] {"", "{", "[1,]", "{\"a\" 1}", "01", "1.", "\"\\x\"", "tru", "1 2", "\"\u0001\""})
      assertThrows(IllegalArgumentException.class, () -> Json.parse(bad), bad);
  }

  @Test
  @DisplayName("close is idempotent and reads keep working")
  void close() {
    KeepYourPrompts c = quiet().snapshotDir(fixture("v12")).build();
    c.close();
    c.close();
    assertEquals(GREETING_V4, c.get("greeting"));
    assertFalse(c.refresh());
  }
}
