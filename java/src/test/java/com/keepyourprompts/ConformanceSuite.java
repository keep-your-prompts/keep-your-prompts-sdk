package com.keepyourprompts;

import static com.keepyourprompts.TestSupport.GREETING_V4;
import static com.keepyourprompts.TestSupport.GREETING_V5;
import static com.keepyourprompts.TestSupport.deploy;
import static com.keepyourprompts.TestSupport.quiet;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * conformance/README.md "Required behaviour" 4 to 12 over HTTP, with the exact fixtures. Runs once against the
 * in-JVM fake and once against conformance/fake_cdn.py.
 */
abstract class ConformanceSuite {
  static final String KEY = "kypd_test";
  static final String GIT_TOKEN = "github_pat_readonly";

  @TempDir Path tmp;
  Path cdnDir;
  Path originDir;
  Path gitDir;
  FakeCdn server;
  final List<KeepYourPrompts> clients = new ArrayList<>();

  abstract FakeCdn.Factory factory();

  @BeforeEach
  void startServer() throws Exception {
    cdnDir = tmp.resolve("cdn");
    originDir = tmp.resolve("origin");
    gitDir = tmp.resolve("git");
    for (Path d : new Path[] {cdnDir, originDir, gitDir}) deploy("v12", d);
    server = factory().start(Map.of(
        "cdn", Map.entry("/v1/d/" + KEY, cdnDir),
        "origin", Map.entry("/v1/delivery/" + KEY, originDir),
        "git", Map.entry("/acme/prompts/main/.kyp", gitDir)));
  }

  @AfterEach
  void stop() {
    clients.forEach(KeepYourPrompts::close);
    if (server != null) server.close();
  }

  KeepYourPrompts.Builder options() {
    return quiet()
        .deliveryKey(KEY)
        .cdnBase(server.base() + "/v1/d")
        .originBase(server.base() + "/v1/delivery")
        .gitMirror(server.base() + "/acme/prompts/main/.kyp", GIT_TOKEN)
        .pollInterval(Duration.ofHours(1)) // tests drive refresh() themselves
        .startupTimeout(Duration.ofSeconds(3));
  }

  KeepYourPrompts start(KeepYourPrompts.Builder b) {
    KeepYourPrompts c = b.build();
    clients.add(c);
    return c;
  }

  @Test
  @DisplayName("4. hash check: a tampered blob is rejected and revision 12 kept")
  void hashCheck() {
    KeepYourPrompts c = start(options());
    assertEquals(12, c.revision());
    deploy("tampered-v14", cdnDir);
    assertTrue(c.refresh(), "origin still answers");
    assertEquals(12, c.revision());
    assertEquals(GREETING_V4, c.get("greeting"));
    MirrorStatus cdn = c.status().mirrors().stream().filter(m -> m.name().equals("cdn")).findFirst().orElseThrow();
    assertTrue(cdn.lastError().contains("sha256"), cdn.lastError());

    // With only the tampered mirror answering, nothing is installed.
    server.down("origin");
    server.down("git");
    assertFalse(c.refresh());
    assertEquals(12, c.revision());
    assertTrue(c.status().lastError().contains("failed sha256 verification"), c.status().lastError());
  }

  @Test
  @DisplayName("4. hash check: a tampered mirror cannot be the start-up source")
  void hashCheckAtStartup() {
    deploy("tampered-v14", cdnDir);
    deploy("tampered-v14", originDir);
    deploy("tampered-v14", gitDir);
    assertThrows(UnavailableException.class, () -> start(options().startupTimeout(Duration.ofMillis(300))));
  }

  @Test
  @DisplayName("6. mirror order and fallback: CDN, then origin, then git with a bearer token")
  void mirrorOrderAndFallback() {
    KeepYourPrompts c = start(options());
    assertEquals("cdn", c.status().source());
    assertEquals(0, server.stat("origin", "200"));
    assertEquals(0, server.stat("git", "200"));
    assertNull(server.auth("cdn"), "the CDN gets the key in the path, not a header");

    server.down("cdn");
    assertTrue(c.refresh());
    assertEquals("origin", c.status().source());
    assertTrue(c.status().lastError().contains("cdn: HTTP 503"), c.status().lastError());
    assertEquals(0, server.stat("git", "200") + server.stat("git", "304"));

    server.down("origin");
    assertTrue(c.refresh());
    assertEquals("git", c.status().source());
    assertEquals("Bearer " + GIT_TOKEN, server.auth("git"));
    assertEquals(GREETING_V4, c.get("greeting"));

    // Recovery: the CDN answers first again.
    server.up("cdn");
    server.up("origin");
    assertTrue(c.refresh());
    assertEquals("cdn", c.status().source());
    assertEquals("", c.status().lastError());
  }

  @Test
  @DisplayName("6. delivery key never appears in status()")
  void keyRedacted() {
    KeepYourPrompts c = start(options().deliveryKey("kypd_Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4f")
        .startupTimeout(Duration.ofMillis(200)).startEmpty(true));
    for (MirrorStatus m : c.status().mirrors()) assertFalse(m.url().contains("Ab3dEf6hIj9l"), m.url());
    assertFalse(c.status().lastError().contains("Ab3dEf6hIj9l"));
  }

  @Test
  @DisplayName("7. revalidation: polls send If-None-Match and a 304 changes nothing")
  void revalidation() {
    List<Update> updates = new CopyOnWriteArrayList<>();
    KeepYourPrompts c = start(options().onUpdate(updates::add));
    int blobsAndManifest = server.stat("cdn", "200");
    assertEquals(0, server.stat("cdn", "304"));
    assertTrue(c.refresh());
    assertEquals(1, server.stat("cdn", "304"));
    assertTrue(c.refresh());
    assertEquals(2, server.stat("cdn", "304"));
    assertEquals(blobsAndManifest, server.stat("cdn", "200"), "no re-download");
    assertEquals(12, c.revision());
    assertTrue(updates.isEmpty());
    assertTrue(c.status().lastSuccess() != null);
  }

  @Test
  @DisplayName("8. hot update: v12 -> v13 after one refresh, callback fires once")
  void hotUpdate() {
    List<Update> updates = new CopyOnWriteArrayList<>();
    KeepYourPrompts c = start(options().onUpdate(updates::add));
    assertEquals(4, c.prompt("greeting").version());
    deploy("v13", cdnDir);
    assertTrue(c.refresh());
    assertEquals(13, c.revision());
    assertEquals(5, c.prompt("greeting").version());
    assertEquals(GREETING_V5, c.get("greeting"));
    assertEquals("Hi Ana! Acme is glad you are here.", c.render("greeting", Map.of("name", "Ana", "company", "Acme")));
    assertTrue(c.refresh());
    assertEquals(1, updates.size());
    Update u = updates.get(0);
    assertEquals(12, u.oldRevision());
    assertEquals(13, u.newRevision());
    assertEquals("cdn", u.source());
    assertEquals(List.of("greeting"), u.changed());
  }

  @Test
  @DisplayName("8. hot update through the background refresher")
  void hotUpdateInBackground() throws Exception {
    CountDownLatch fired = new CountDownLatch(1);
    KeepYourPrompts c = start(options().pollInterval(Duration.ofMillis(100)));
    c.onUpdate(u -> fired.countDown());
    deploy("v13", cdnDir);
    assertTrue(fired.await(5, java.util.concurrent.TimeUnit.SECONDS));
    assertEquals(GREETING_V5, c.get("greeting"));
  }

  @Test
  @DisplayName("9. stale mirror: v11 never replaces revision 12")
  void staleMirror() {
    KeepYourPrompts c = start(options());
    deploy("v11-stale", cdnDir);
    server.down("origin");
    server.down("git");
    assertFalse(c.refresh());
    assertEquals(12, c.revision());
    assertEquals(GREETING_V4, c.get("greeting"));
    assertTrue(c.status().lastError().contains("stale manifest ignored"), c.status().lastError());
  }

  @Test
  @DisplayName("10. failures never evict: everything down, get keeps serving, status reports it")
  void failuresNeverEvict() throws Exception {
    KeepYourPrompts c = start(options());
    server.down("cdn");
    server.down("origin");
    server.down("git");
    Thread.sleep(30);
    assertFalse(c.refresh());
    assertEquals(GREETING_V4, c.get("greeting"));
    Status st = c.status();
    assertTrue(st.ready());
    assertEquals(12, st.revision());
    assertTrue(st.lastError().contains("cdn: HTTP 503"), st.lastError());
    assertTrue(st.lastError().contains("origin: HTTP 503"), st.lastError());
    assertTrue(st.lastError().contains("git: HTTP 503"), st.lastError());
    assertTrue(st.staleFor().toMillis() >= 30, st.staleFor().toString());
    assertTrue(st.mirrors().stream().filter(m -> m.name().equals("cdn")).findFirst().orElseThrow()
        .consecutiveFailures() >= 1);

    // The server process can disappear entirely.
    server.close();
    server = null;
    assertFalse(c.refresh());
    assertEquals(GREETING_V4, c.get("greeting"));
  }

  @Test
  @DisplayName("10. start-up with nothing reachable: Unavailable after the timeout, or start empty")
  void startupTimeout() throws Exception {
    server.down("cdn");
    server.down("origin");
    server.down("git");
    long t0 = System.nanoTime();
    assertThrows(UnavailableException.class, () -> start(options().startupTimeout(Duration.ofMillis(400))));
    long took = (System.nanoTime() - t0) / 1_000_000;
    assertTrue(took >= 250 && took < 3000, "took " + took + " ms");

    KeepYourPrompts c = start(options().startupTimeout(Duration.ofMillis(200)).startEmpty(true)
        .pollInterval(Duration.ofMillis(100)).maxBackoff(Duration.ofMillis(200)));
    assertFalse(c.status().ready());
    assertTrue(c.tryGet("greeting").isEmpty());
    assertThrows(PromptNotFoundException.class, () -> c.get("greeting"));
    server.up("origin");
    assertTrue(TestSupport.eventually(() -> c.tryGet("greeting").isPresent(), Duration.ofSeconds(5)));
    assertEquals("origin", c.status().source());
  }

  @Test
  @DisplayName("11. disk cache: a new client with only the cache directory starts from it")
  void diskCache() {
    Path cache = tmp.resolve("cache");
    KeepYourPrompts first = start(options().cacheDir(cache));
    assertEquals(12, first.revision());
    first.close();
    assertTrue(cache.resolve("acme/demo/prod/envs/demo/prod.json").toFile().isFile());

    KeepYourPrompts offline = start(quiet().cacheDir(cache));
    assertEquals("disk-cache", offline.status().source());
    assertEquals(GREETING_V4, offline.get("greeting"));

    // Network configured but down: still instant from the cache.
    server.down("cdn");
    server.down("origin");
    server.down("git");
    long t0 = System.nanoTime();
    KeepYourPrompts down = start(options().cacheDir(cache));
    assertTrue((System.nanoTime() - t0) / 1_000_000 < 1000);
    assertEquals(GREETING_V4, down.get("greeting"));
    assertEquals("disk-cache", down.status().source());
  }

  @Test
  @DisplayName("11. disk cache follows hot updates")
  void diskCacheFollowsUpdates() {
    Path cache = tmp.resolve("cache");
    KeepYourPrompts c = start(options().cacheDir(cache));
    deploy("v13", cdnDir);
    assertTrue(c.refresh());
    c.close();
    KeepYourPrompts offline = start(quiet().cacheDir(cache));
    assertEquals(13, offline.revision());
    assertEquals(GREETING_V5, offline.get("greeting"));
  }

  @Test
  @DisplayName("12. read path: get is safe from many threads during swaps")
  void concurrentReads() throws Exception {
    KeepYourPrompts c = start(options());
    AtomicBoolean stop = new AtomicBoolean();
    AtomicReference<Throwable> failure = new AtomicReference<>();
    AtomicLong reads = new AtomicLong();
    List<Thread> threads = new ArrayList<>();
    for (int t = 0; t < 8; t++) {
      Thread th = new Thread(() -> {
        try {
          while (!stop.get()) {
            String g = c.get("greeting");
            if (!g.equals(GREETING_V4) && !g.equals(GREETING_V5)) throw new AssertionError(g);
            Prompt p = c.prompt("greeting");
            if (!Templates.sha256Hex(p.text()).equals(p.sha256())) throw new AssertionError("torn read");
            c.render("triage", Map.of("company", "Acme"));
            reads.incrementAndGet();
          }
        } catch (Throwable e) {
          failure.compareAndSet(null, e);
        }
      });
      th.start();
      threads.add(th);
    }
    Thread.sleep(100);
    deploy("v13", cdnDir);
    assertTrue(c.refresh());
    Thread.sleep(100);
    stop.set(true);
    for (Thread th : threads) th.join();
    if (failure.get() != null) throw new AssertionError(failure.get());
    assertTrue(reads.get() > 1000, "reads: " + reads.get());
    assertEquals(GREETING_V5, c.get("greeting"));
  }
}
