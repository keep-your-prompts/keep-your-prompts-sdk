package com.keepyourprompts;

import com.keepyourprompts.Transport.MirrorKind;
import com.keepyourprompts.Transport.Result;
import java.io.IOException;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * Keep Your Prompts client: serves deployed prompts from memory and keeps them fresh in the background.
 *
 * <pre>{@code
 * try (KeepYourPrompts prompts = KeepYourPrompts.fromEnv()) {   // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
 *   String system = prompts.render("triage", Map.of("company", "Acme"));
 * }
 * }</pre>
 *
 * <p>Implements prompt delivery protocol v1: interchangeable mirrors with one layout (class-path snapshot,
 * snapshot folder, disk cache, CDN, origin, git), a manifest plus content-addressed blobs verified with
 * SHA-256, ETag revalidation, a daemon refresher thread and an atomic in-memory swap. Reads ({@link #get},
 * {@link #render}, {@link #prompt}) never do I/O and are safe from any number of threads.
 */
public final class KeepYourPrompts implements AutoCloseable {
  /** SDK version. */
  public static final String VERSION = "0.1.0";

  static final String DEFAULT_CDN = "https://cdn.keepyourprompts.com/v1/d";
  static final String DEFAULT_ORIGIN = "https://api.keepyourprompts.com/v1/delivery";

  // ===========================================================================================
  // Builder
  // ===========================================================================================

  /** Fluent configuration. Only {@code app} is required ({@code env} defaults to {@code prod}). */
  public static final class Builder {
    String app = "";
    String env = "prod";
    String deliveryKey = "";
    String workspace = "";
    List<Mirror> mirrors = List.of();
    boolean explicitMirrors;
    final List<Mirror> extraMirrors = new ArrayList<>();
    Path snapshotDir;
    String classpathPrefix;
    ClassLoader classLoader;
    Path cacheDir;
    String gitUrl = "";
    String gitToken = "";
    String cdnBase = DEFAULT_CDN;
    String originBase = DEFAULT_ORIGIN;
    Duration pollInterval = Duration.ofSeconds(30);
    Duration connectTimeout = Duration.ofSeconds(2);
    Duration requestTimeout = Duration.ofSeconds(5);
    Duration startupTimeout = Duration.ofSeconds(3);
    Duration maxBackoff = Duration.ofMinutes(5);
    boolean startEmpty;
    String userAgent = "kyp-java/" + VERSION;
    final List<Consumer<Update>> listeners = new ArrayList<>();
    final List<Telemetry.Observer> observers = new ArrayList<>();
    BiConsumer<LogLevel, String> logger;
    LogLevel logLevel = LogLevel.WARN;

    Builder() {}

    /**
     * Reads {@code KYP_APP}, {@code KYP_ENV}, {@code KYP_DELIVERY_KEY}, {@code KYP_WORKSPACE},
     * {@code KYP_SNAPSHOT_DIR} (a folder, or {@code classpath:<prefix>}), {@code KYP_CACHE_DIR},
     * {@code KYP_GIT_MIRROR}, {@code KYP_GIT_TOKEN}, {@code KYP_CDN_URL}, {@code KYP_ORIGIN_URL},
     * {@code KYP_POLL_INTERVAL} (seconds) and {@code KYP_LOG} (debug|info|warn|error|off).
     */
    static Builder fromEnvironment(Function<String, String> getenv) {
      Function<String, String> g = k -> Optional.ofNullable(getenv.apply(k)).orElse("").trim();
      Builder b = new Builder();
      b.app(g.apply("KYP_APP"));
      if (!g.apply("KYP_ENV").isEmpty()) b.env(g.apply("KYP_ENV"));
      b.deliveryKey(g.apply("KYP_DELIVERY_KEY"));
      b.workspace(g.apply("KYP_WORKSPACE"));
      String snap = g.apply("KYP_SNAPSHOT_DIR");
      if (snap.startsWith("classpath:")) b.snapshotFromClasspath(snap.substring("classpath:".length()));
      else if (!snap.isEmpty()) b.snapshotDir(Paths.get(snap));
      if (!g.apply("KYP_CACHE_DIR").isEmpty()) b.cacheDir(Paths.get(g.apply("KYP_CACHE_DIR")));
      if (!g.apply("KYP_GIT_MIRROR").isEmpty()) b.gitMirror(g.apply("KYP_GIT_MIRROR"), g.apply("KYP_GIT_TOKEN"));
      if (!g.apply("KYP_CDN_URL").isEmpty()) b.cdnBase(g.apply("KYP_CDN_URL"));
      if (!g.apply("KYP_ORIGIN_URL").isEmpty()) b.originBase(g.apply("KYP_ORIGIN_URL"));
      String poll = g.apply("KYP_POLL_INTERVAL");
      if (!poll.isEmpty()) {
        try {
          double secs = Double.parseDouble(poll);
          if (secs > 0) b.pollInterval(Duration.ofMillis((long) (secs * 1000)));
        } catch (NumberFormatException ignored) {
          // keep the default
        }
      }
      switch (g.apply("KYP_LOG")) {
        case "off": b.logLevel(LogLevel.OFF); break;
        case "debug": b.logLevel(LogLevel.DEBUG); break;
        case "info": b.logLevel(LogLevel.INFO); break;
        case "error": b.logLevel(LogLevel.ERROR); break;
        default: break;
      }
      return b;
    }

    /** App slug, {@code [a-z0-9][a-z0-9-]{0,62}}. Required. */
    public Builder app(String v) {
      app = Objects.requireNonNull(v);
      return this;
    }

    /** Environment slug. Default {@code prod}. */
    public Builder env(String v) {
      env = Objects.requireNonNull(v);
      return this;
    }

    /** Read-only delivery key ({@code kypd_...}); enables the CDN and origin mirrors. */
    public Builder deliveryKey(String v) {
      deliveryKey = v == null ? "" : v;
      return this;
    }

    /** Optional: lets the disk cache be found without scanning {@code cacheDir}. */
    public Builder workspace(String v) {
      workspace = v == null ? "" : v;
      return this;
    }

    /** Replace the snapshot/CDN/origin/git mirrors with an explicit ordered list. */
    public Builder mirrors(List<Mirror> v) {
      mirrors = List.copyOf(v);
      explicitMirrors = true;
      return this;
    }

    /** Append a mirror after the defaults (or after {@link #mirrors}). */
    public Builder addMirror(Mirror m) {
      extraMirrors.add(Objects.requireNonNull(m));
      return this;
    }

    /** A snapshot folder written by {@code kyp pull} (mirror {@code snapshot}). */
    public Builder snapshotDir(Path v) {
      snapshotDir = v;
      return this;
    }

    /**
     * A snapshot packaged as class-path resources under {@code prefix} (mirror {@code embedded}), e.g.
     * {@code src/main/resources/prompts/envs/...}: a fat jar or container then starts with zero network.
     */
    public Builder snapshotFromClasspath(String prefix) {
      classpathPrefix = Objects.requireNonNull(prefix);
      return this;
    }

    public Builder snapshotFromClasspath(String prefix, ClassLoader loader) {
      classLoader = loader;
      return snapshotFromClasspath(prefix);
    }

    /** Where verified states are written so a restart without network comes up on the last version seen. */
    public Builder cacheDir(Path v) {
      cacheDir = v;
      return this;
    }

    /** Your git sync target, e.g. {@code https://raw.githubusercontent.com/acme/prompts/main/.kyp}. */
    public Builder gitMirror(String baseUrl, String token) {
      gitUrl = baseUrl == null ? "" : baseUrl;
      gitToken = token == null ? "" : token;
      return this;
    }

    public Builder gitMirror(String baseUrl) {
      return gitMirror(baseUrl, "");
    }

    public Builder cdnBase(String v) {
      cdnBase = Objects.requireNonNull(v);
      return this;
    }

    public Builder originBase(String v) {
      originBase = Objects.requireNonNull(v);
      return this;
    }

    /** How often the manifest is revalidated (plus or minus 10% jitter). Default 30 s, minimum 100 ms. */
    public Builder pollInterval(Duration v) {
      pollInterval = Objects.requireNonNull(v);
      return this;
    }

    public Builder connectTimeout(Duration v) {
      connectTimeout = Objects.requireNonNull(v);
      return this;
    }

    public Builder requestTimeout(Duration v) {
      requestTimeout = Objects.requireNonNull(v);
      return this;
    }

    /** How long {@link #build()} blocks on the network when nothing local exists. Default 3 s. */
    public Builder startupTimeout(Duration v) {
      startupTimeout = Objects.requireNonNull(v);
      return this;
    }

    /** Cap on how long a failing mirror is skipped. Default 5 min. */
    public Builder maxBackoff(Duration v) {
      maxBackoff = Objects.requireNonNull(v);
      return this;
    }

    /** Start with no prompts instead of throwing {@link UnavailableException}. */
    public Builder startEmpty(boolean v) {
      startEmpty = v;
      return this;
    }

    public Builder userAgent(String v) {
      userAgent = Objects.requireNonNull(v);
      return this;
    }

    /** Called on the refresher thread after a new revision was swapped in. */
    public Builder onUpdate(Consumer<Update> listener) {
      listeners.add(Objects.requireNonNull(listener));
      return this;
    }

    /** Custom log sink; default is {@link System.Logger} {@code com.keepyourprompts}. */
    /** Delivery telemetry hook, registered before start-up so the start-up round is seen too. */
    public Builder observer(Telemetry.Observer o) {
      observers.add(Objects.requireNonNull(o));
      return this;
    }

    public Builder logger(BiConsumer<LogLevel, String> v) {
      logger = v;
      return this;
    }

    /** Minimum level that is logged. Default {@link LogLevel#WARN}. */
    public Builder logLevel(LogLevel v) {
      logLevel = Objects.requireNonNull(v);
      return this;
    }

    /** Loads prompts (local mirrors first, then the network up to {@code startupTimeout}). */
    public KeepYourPrompts build() {
      return new KeepYourPrompts(this, false);
    }
  }

  /** A new builder. */
  public static Builder builder() {
    return new Builder();
  }

  /** A builder preloaded from {@code KYP_*} environment variables, for further tweaks. */
  public static Builder builderFromEnv() {
    return Builder.fromEnvironment(System::getenv);
  }

  /** {@code builderFromEnv().build()}. */
  public static KeepYourPrompts fromEnv() {
    return builderFromEnv().build();
  }

  // ===========================================================================================
  // State
  // ===========================================================================================

  /** Immutable once published. */
  static final class State {
    final Manifest manifest;
    final byte[] rawManifest;
    final Map<String, Prompt> index;
    final Map<String, String> bySha;
    final List<String> names;

    State(Manifest manifest, byte[] rawManifest, List<Prompt> prompts) {
      this.manifest = manifest;
      this.rawManifest = rawManifest;
      Map<String, Prompt> idx = new HashMap<>(prompts.size() * 2);
      Map<String, String> sha = new HashMap<>(prompts.size() * 2);
      List<String> ns = new ArrayList<>(prompts.size());
      for (Prompt p : prompts) {
        idx.put(p.name(), p);
        sha.put(p.sha256(), p.text());
        ns.add(p.name());
      }
      this.index = Collections.unmodifiableMap(idx);
      this.bySha = Collections.unmodifiableMap(sha);
      this.names = List.copyOf(ns);
    }
  }

  static final class MirrorRt {
    final Mirror cfg;
    final MirrorKind kind;
    final String shownUrl;
    final String source; // kyp.source
    String etag = ""; // guarded by refreshLock
    // guarded by statusLock
    int failures;
    long retryAt; // System.nanoTime(); 0 = not backing off
    String lastError = "";
    Instant lastOk;

    MirrorRt(Mirror cfg, MirrorKind kind, String shownUrl) {
      this.cfg = cfg;
      this.kind = kind;
      this.shownUrl = shownUrl;
      this.source = Telemetry.normalizeSource(cfg);
    }
  }

  private enum Outcome {
    UPDATED,
    UNCHANGED,
    STALE,
    FAILED
  }

  private static final class Candidate {
    State state;
    String etag = "";
    boolean missing;
    String error = "";
  }

  // --- configuration -------------------------------------------------------------------------
  private final String app;
  private final String env;
  private final String deliveryKey;
  private final String workspace;
  private final Path cacheDir;
  private final ClassLoader classLoader;
  private final long pollMs;
  private final long maxBackoffMs;
  private final Duration startupTimeout;
  private final boolean startEmpty;
  private final BiConsumer<LogLevel, String> logger;
  private final LogLevel logLevel;

  // --- mirrors -------------------------------------------------------------------------------
  private final List<MirrorRt> mirrors = new ArrayList<>();
  private final int[] polled;
  private int cacheIdx = -1;
  private final Transport.Http http;

  // --- runtime -------------------------------------------------------------------------------
  private final AtomicReference<State> state = new AtomicReference<>();
  private final Object refreshLock = new Object(); // one round at a time; guards etags and cacheRoot
  private Path cacheRoot;
  private final Object statusLock = new Object();
  private final Instant started = Instant.now();
  private Instant lastSuccess;
  private String lastError = "";
  private String source = "";
  private final CopyOnWriteArrayList<Consumer<Update>> listeners = new CopyOnWriteArrayList<>();
  private final List<Update> pending = new ArrayList<>(); // guarded by itself
  private final Object deliverLock = new Object();
  private final CopyOnWriteArrayList<Telemetry.Observer> observers = new CopyOnWriteArrayList<>();
  private List<Telemetry.Event> roundEvents = new ArrayList<>(); // guarded by refreshLock
  private volatile String sourceKind = "";
  private volatile boolean closed;
  private volatile Thread refresherThread;
  private final ScheduledExecutorService exec;

  private KeepYourPrompts(Builder b, boolean forSnapshot) {
    if (b.app.isEmpty()) throw new KypException("kyp: app is not set (builder.app or KYP_APP)");
    if (!Manifest.isSlug(b.app))
      throw new KypException("kyp: app \"" + b.app + "\" is not a slug ([a-z0-9][a-z0-9-]{0,62})");
    if (!Manifest.isSlug(b.env))
      throw new KypException("kyp: env \"" + b.env + "\" is not a slug ([a-z0-9][a-z0-9-]{0,62})");
    for (int i = 0; i < b.deliveryKey.length(); i++) {
      char c = b.deliveryKey.charAt(i);
      if (!(Character.isLetterOrDigit(c) && c < 128) && c != '_' && c != '-')
        throw new KypException("kyp: the delivery key contains an invalid character");
    }
    this.app = b.app;
    this.env = b.env;
    this.deliveryKey = b.deliveryKey;
    this.workspace = b.workspace;
    this.cacheDir = forSnapshot ? null : b.cacheDir;
    this.classLoader =
        b.classLoader != null
            ? b.classLoader
            : Optional.ofNullable(Thread.currentThread().getContextClassLoader())
                .orElse(KeepYourPrompts.class.getClassLoader());
    this.pollMs = Math.max(100, b.pollInterval.toMillis());
    this.maxBackoffMs = Math.max(0, b.maxBackoff.toMillis());
    this.startupTimeout = b.startupTimeout;
    this.startEmpty = b.startEmpty;
    this.logger = b.logger;
    this.logLevel = b.logLevel;
    this.listeners.addAll(b.listeners);
    this.observers.addAll(b.observers);
    if (!deliveryKey.isEmpty() && !deliveryKey.startsWith("kypd_"))
      log(LogLevel.WARN, "delivery key does not start with kypd_; check KYP_DELIVERY_KEY");

    // Order: class-path snapshot, snapshot folder, disk cache, CDN, origin, git, extras.
    List<Mirror> rest = new ArrayList<>();
    if (b.explicitMirrors) {
      rest.addAll(b.mirrors);
    } else {
      if (b.snapshotDir != null) rest.add(Mirror.file(b.snapshotDir, "snapshot"));
      if (!deliveryKey.isEmpty()) {
        rest.add(Mirror.http(Transport.joinUrl(b.cdnBase, deliveryKey), "cdn"));
        rest.add(Mirror.http(Transport.joinUrl(b.originBase, deliveryKey), "origin"));
      }
      if (!b.gitUrl.isEmpty()) rest.add(Mirror.http(b.gitUrl, "git", b.gitToken));
    }
    rest.addAll(b.extraMirrors);
    if (b.classpathPrefix != null && !forSnapshot) add(Mirror.classpath(b.classpathPrefix));
    boolean cacheAdded = false;
    for (Mirror m : rest) {
      MirrorKind k = Transport.kindOf(m.url());
      if (k == MirrorKind.CLASSPATH && forSnapshot) continue;
      if (!cacheAdded && cacheDir != null && k == MirrorKind.HTTP) {
        addCache();
        cacheAdded = true;
      }
      add(m);
    }
    if (!cacheAdded && cacheDir != null) addCache();

    List<Integer> p = new ArrayList<>();
    for (int i = 0; i < mirrors.size(); i++) if (mirrors.get(i).kind == MirrorKind.HTTP) p.add(i);
    if (p.isEmpty()) {
      // No network mirrors: poll the file mirrors (e.g. a snapshot folder kept fresh by a sidecar or git pull).
      for (int i = 0; i < mirrors.size(); i++) if (mirrors.get(i).kind == MirrorKind.FILE) p.add(i);
      http = null;
    } else {
      http = new Transport.Http(b.connectTimeout, b.requestTimeout, b.userAgent);
    }
    polled = p.stream().mapToInt(Integer::intValue).toArray();

    if (forSnapshot) {
      exec = null;
      return;
    }

    loadLocal();
    boolean loadedLocally = state.get() != null;
    if (!loadedLocally) {
      if (polled.length == 0) {
        if (!startEmpty)
          throw new UnavailableException(
              "kyp: no prompts for " + what()
                  + ": no snapshot or disk cache found and no remote mirror configured "
                  + "(set KYP_DELIVERY_KEY, KYP_SNAPSHOT_DIR or a class-path snapshot)");
        log(LogLevel.WARN, "starting empty: no mirror for " + what());
      } else {
        startupFromNetwork();
      }
    }
    if (polled.length > 0) {
      String threadName = "kyp-refresh-" + app + "/" + env;
      exec =
          Executors.newSingleThreadScheduledExecutor(
              r -> {
                Thread t = new Thread(r, threadName);
                t.setDaemon(true);
                refresherThread = t;
                return t;
              });
      boolean immediate = loadedLocally || state.get() == null;
      schedule(immediate ? 0 : jittered(pollMs));
    } else {
      exec = null;
    }
  }

  private void add(Mirror m) {
    mirrors.add(new MirrorRt(m, Transport.kindOf(m.url()), redact(m.url())));
  }

  private void addCache() {
    cacheIdx = mirrors.size();
    mirrors.add(new MirrorRt(new Mirror("disk-cache", cacheDir.toString(), ""), MirrorKind.CACHE, cacheDir.toString()));
  }

  private String manifestPath() {
    return "envs/" + app + "/" + env + ".json";
  }

  private String what() {
    return app + "/" + env;
  }

  // ===========================================================================================
  // Public API: reads
  // ===========================================================================================

  private Prompt find(String name) {
    return findIn(state.get(), name);
  }

  private Prompt findIn(State s, String name) {
    if (s != null) {
      Prompt p = s.index.get(name);
      if (p != null) return p;
    }
    throw new PromptNotFoundException(
        name, s != null ? what() + " revision " + s.manifest.revision : "nothing loaded for " + what());
  }

  /** The raw template. Throws {@link PromptNotFoundException}. No I/O. */
  public String get(String name) {
    return find(name).text();
  }

  /** The raw template, or empty if the name is not deployed. */
  public Optional<String> tryGet(String name) {
    State s = state.get();
    Prompt p = s == null ? null : s.index.get(name);
    return p == null ? Optional.empty() : Optional.of(p.text());
  }

  public boolean contains(String name) {
    State s = state.get();
    return s != null && s.index.containsKey(name);
  }

  /** Name, version, sha256, variables and text. Throws {@link PromptNotFoundException}. */
  public Prompt prompt(String name) {
    return find(name);
  }

  /**
   * Renders a prompt; values are converted with {@code String.valueOf}. Throws {@link PromptNotFoundException}
   * or {@link MissingVariableException}.
   */
  public String render(String name, Map<String, ?> vars) {
    return render(name, vars, OnMissing.ERROR);
  }

  public String render(String name, Map<String, ?> vars, OnMissing onMissing) {
    try {
      return Templates.render(find(name).text(), vars, onMissing);
    } catch (PromptNotFoundException | MissingVariableException e) {
      renderFailed(name, e);
      throw e;
    }
  }

  /**
   * Which deployed body {@code name} is: name, version, sha256, app, env, workspace, revision and the mirror kind
   * that served it. No I/O. Throws {@link PromptNotFoundException}.
   */
  public PromptMeta meta(String name) {
    State s = state.get();
    return metaOf(findIn(s, name), s);
  }

  /** {@link #render(String, Map)} plus the metadata of the exact body rendered. */
  public Rendered renderWithMeta(String name, Map<String, ?> vars) {
    return renderWithMeta(name, vars, OnMissing.ERROR);
  }

  public Rendered renderWithMeta(String name, Map<String, ?> vars, OnMissing onMissing) {
    State s = state.get();
    try {
      Prompt p = findIn(s, name);
      return new Rendered(Templates.render(p.text(), vars, onMissing), metaOf(p, s));
    } catch (PromptNotFoundException | MissingVariableException e) {
      renderFailed(name, e);
      throw e;
    }
  }

  /** Subscribes to delivery telemetry (refresh rounds, render errors). Returns a handle that unsubscribes. */
  public Runnable addObserver(Telemetry.Observer observer) {
    observers.add(Objects.requireNonNull(observer));
    return () -> observers.remove(observer);
  }

  /** App slug this client serves. */
  public String app() {
    return app;
  }

  /** Environment slug this client serves. */
  public String env() {
    return env;
  }

  /** Prompt names in the current revision, sorted. */
  public List<String> names() {
    State s = state.get();
    return s == null ? List.of() : s.names;
  }

  /** Current revision, 0 when nothing is loaded. */
  public long revision() {
    State s = state.get();
    return s == null ? 0 : s.manifest.revision;
  }

  /** Health, for logs, metrics and readiness probes. */
  public Status status() {
    State s = state.get();
    List<MirrorStatus> ms = new ArrayList<>();
    synchronized (statusLock) {
      for (MirrorRt m : mirrors)
        ms.add(new MirrorStatus(m.cfg.name(), m.shownUrl, m.failures, m.lastError, m.lastOk));
      Instant since = lastSuccess != null ? lastSuccess : started;
      Duration stale = Duration.between(since, Instant.now());
      if (stale.isNegative()) stale = Duration.ZERO;
      return new Status(
          s != null,
          source,
          s == null ? 0 : s.manifest.revision,
          s == null ? "" : s.manifest.workspace,
          s == null ? "" : s.manifest.deployedAt,
          s == null ? 0 : s.names.size(),
          lastSuccess,
          lastError,
          stale,
          ms);
    }
  }

  /**
   * Registers a listener called after a new revision is swapped in (on the refresher thread, or on the
   * thread calling {@link #refresh()}). Returns a handle that unregisters it.
   */
  public Runnable onUpdate(Consumer<Update> listener) {
    listeners.add(Objects.requireNonNull(listener));
    return () -> listeners.remove(listener);
  }

  /**
   * Revalidates now across the network mirrors, ignoring backoff. Blocks for at most one round of requests.
   * Returns {@code true} if a mirror answered.
   */
  public boolean refresh() {
    if (polled.length == 0 || closed) return false;
    boolean ok;
    synchronized (refreshLock) {
      ok = round(true, Long.MAX_VALUE, "manual");
    }
    deliverUpdates();
    return ok;
  }

  /** Stops the background refresher. Reads keep working. Idempotent. */
  @Override
  public void close() {
    if (closed) return;
    closed = true;
    if (exec != null) {
      exec.shutdownNow();
      if (Thread.currentThread() != refresherThread) {
        try {
          exec.awaitTermination(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
        }
      }
    }
  }

  // ===========================================================================================
  // Snapshot pulling
  // ===========================================================================================

  /** What {@link #pullSnapshot} wrote. */
  public record SnapshotInfo(String workspace, long revision, int promptCount, int blobsWritten, String source) {}

  /**
   * Pulls the deployed manifest and its blobs from the configured network mirrors and writes the layout to
   * {@code outDir} (what {@code kyp pull} does), e.g. from a build step that bakes prompts into the jar.
   */
  public static SnapshotInfo pullSnapshot(Builder options, Path outDir) {
    KeepYourPrompts e = new KeepYourPrompts(options, true);
    StringBuilder errors = new StringBuilder();
    for (int mi : e.polled) {
      Candidate c = new Candidate();
      Outcome oc;
      synchronized (e.refreshLock) {
        oc = e.tryMirror(mi, null, false, Long.MAX_VALUE, c);
      }
      if (oc != Outcome.UPDATED) {
        if (errors.length() > 0) errors.append("; ");
        errors.append(e.mirrors.get(mi).cfg.name()).append(": ").append(c.error);
        continue;
      }
      State st = c.state;
      int written = 0;
      try {
        for (Prompt p : st.index.values()) {
          Path blob = outDir.resolve("blobs").resolve(p.sha256());
          byte[] data = p.text().getBytes(StandardCharsets.UTF_8);
          Result existing = Transport.readFile(blob);
          if (existing.kind() == Transport.Kind.OK && Arrays.equals(existing.body(), data)) continue;
          Transport.atomicWrite(blob, data);
          written++;
        }
        Transport.atomicWrite(outDir.resolve(e.manifestPath()), st.rawManifest);
      } catch (IOException ex) {
        throw new KypException("kyp: cannot write snapshot to " + outDir + ": " + ex.getMessage(), ex);
      }
      return new SnapshotInfo(
          st.manifest.workspace, st.manifest.revision, st.names.size(), written, e.mirrors.get(mi).cfg.name());
    }
    if (e.polled.length == 0) errors.append("no remote mirror configured (set a delivery key or a mirror)");
    throw new UnavailableException("kyp: could not pull " + e.what() + ": " + errors);
  }

  // ===========================================================================================
  // Logging
  // ===========================================================================================

  String redact(String text) {
    if (deliveryKey.length() < 8 || text == null) return text;
    return text.replace(deliveryKey, deliveryKey.substring(0, 9) + "...");
  }

  private void log(LogLevel level, String msg) {
    if (logLevel == LogLevel.OFF || level.ordinal() < logLevel.ordinal()) return;
    String m = redact(msg);
    if (logger != null) {
      try {
        logger.accept(level, m);
      } catch (RuntimeException ignored) {
        // a broken logger must not break the client
      }
      return;
    }
    System.Logger.Level l;
    switch (level) {
      case DEBUG: l = System.Logger.Level.DEBUG; break;
      case INFO: l = System.Logger.Level.INFO; break;
      case WARN: l = System.Logger.Level.WARNING; break;
      default: l = System.Logger.Level.ERROR; break;
    }
    System.getLogger("com.keepyourprompts").log(l, "[kyp] " + m);
  }

  // ===========================================================================================
  // Telemetry (protocol/tracing.md)
  // ===========================================================================================

  private PromptMeta metaOf(Prompt p, State s) {
    return new PromptMeta(
        p.name(),
        p.version(),
        p.sha256(),
        app,
        env,
        s == null ? "" : s.manifest.workspace,
        s == null ? 0 : s.manifest.revision,
        sourceKind);
  }

  private void renderFailed(String name, RuntimeException e) {
    if (observers.isEmpty()) return;
    var err =
        new Telemetry.RenderError(
            app, env, name, e instanceof MissingVariableException ? "missing_variable" : "not_found");
    for (Telemetry.Observer o : observers) {
      try {
        o.onRenderError(err);
      } catch (RuntimeException x) {
        log(LogLevel.ERROR, "observer threw: " + x);
      }
    }
  }

  private void event(String name, Map<String, Object> attrs) {
    if (!observers.isEmpty()) roundEvents.add(new Telemetry.Event(name, Instant.now(), attrs));
  }

  private void fallback(int mi, String err) {
    MirrorRt m = mirrors.get(mi);
    Map<String, Object> a = new LinkedHashMap<>();
    a.put("kyp.mirror", m.cfg.name());
    a.put("kyp.source", m.source);
    a.put("error.type", Telemetry.classifyError(err));
    a.put("kyp.error", redact(err));
    event("kyp.fallback", a);
  }

  private void emitRound(
      String trigger, Instant start, long startNanos, int answeredBy, long prev, boolean updated, String err) {
    List<Telemetry.Event> events = roundEvents;
    roundEvents = new ArrayList<>();
    if (observers.isEmpty()) return;
    State s = state.get();
    MirrorRt m = answeredBy >= 0 ? mirrors.get(answeredBy) : null;
    String errorType = "";
    if (m == null) {
      errorType = Telemetry.classifyError(err);
      for (int i = events.size() - 1; i >= 0; i--) {
        if (events.get(i).name().equals("kyp.fallback")) {
          errorType = String.valueOf(events.get(i).attributes().get("error.type"));
          break;
        }
      }
    }
    var rec =
        new Telemetry.RefreshRecord(
            app,
            env,
            trigger,
            m == null ? "failed" : updated ? "updated" : "not_modified",
            start,
            Duration.ofNanos(Math.max(0, System.nanoTime() - startNanos)),
            m == null ? "" : m.cfg.name(),
            m == null ? "" : m.source,
            s == null ? 0 : s.manifest.revision,
            prev,
            s == null ? "" : s.manifest.workspace,
            m == null ? redact(err) : "",
            errorType,
            events);
    for (Telemetry.Observer o : observers) {
      try {
        o.onRefresh(rec);
      } catch (RuntimeException x) {
        log(LogLevel.ERROR, "observer threw: " + x);
      }
    }
  }

  // ===========================================================================================
  // Mirror access
  // ===========================================================================================

  private Result fetch(int mi, String rel, String etag, long deadline) {
    MirrorRt m = mirrors.get(mi);
    Result r;
    switch (m.kind) {
      case CLASSPATH:
        r = Transport.readResource(classLoader, m.cfg.url().substring("classpath:".length()), rel);
        break;
      case FILE:
        try {
          r = Transport.readFile(Transport.fileUrlToPath(m.cfg.url()).resolve(rel));
        } catch (RuntimeException e) {
          r = Result.failed("bad file mirror URL: " + e.getMessage());
        }
        break;
      case CACHE:
        r = cacheRoot == null ? Result.notFound("empty") : Transport.readFile(cacheRoot.resolve(rel));
        break;
      default:
        r = http == null
            ? Result.failed("no HTTP client")
            : http.get(Transport.joinUrl(m.cfg.url(), rel), etag, m.cfg.bearerToken(), deadline);
        break;
    }
    if (!r.error().isEmpty()) r = new Result(r.kind(), r.body(), r.etag(), redact(r.error()));
    return r;
  }

  private boolean inBackoff(int mi) {
    synchronized (statusLock) {
      MirrorRt m = mirrors.get(mi);
      return m.retryAt != 0 && m.retryAt - System.nanoTime() > 0;
    }
  }

  private void recordOk(int mi) {
    boolean recovered;
    MirrorRt m = mirrors.get(mi);
    synchronized (statusLock) {
      recovered = m.failures > 0;
      m.failures = 0;
      m.retryAt = 0;
      m.lastError = "";
      m.lastOk = Instant.now();
    }
    if (recovered) log(LogLevel.INFO, m.cfg.name() + " is answering again");
  }

  private void recordFail(int mi, String err, boolean count) {
    int failures = 0;
    MirrorRt m = mirrors.get(mi);
    synchronized (statusLock) {
      m.lastError = err;
      if (count) {
        failures = ++m.failures;
        // Skip the mirror for 0, 1, 3, 7, ... poll intervals, capped at maxBackoff, with +-10% jitter.
        long mult = (1L << Math.min(failures - 1, 20)) - 1;
        long ms = Math.min(pollMs * mult, maxBackoffMs);
        long jit = (long) (ms * ThreadLocalRandom.current().nextDouble(0.9, 1.1));
        m.retryAt = jit <= 0 ? 0 : System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(jit);
      }
    }
    log(failures == 1 ? LogLevel.WARN : LogLevel.DEBUG, m.cfg.name() + ": " + err);
  }

  // ===========================================================================================
  // Loading
  // ===========================================================================================

  /** Resolves a blob: disk cache, then the mirror that served the manifest, then every other mirror. */
  private String resolveBlob(int mi, String sha, long dl, StringBuilder err) {
    List<Integer> order = new ArrayList<>();
    if (cacheIdx >= 0) order.add(cacheIdx);
    order.add(mi);
    for (int i = 0; i < mirrors.size(); i++) order.add(i);
    boolean[] seen = new boolean[mirrors.size()];
    StringBuilder errors = new StringBuilder();
    for (int i : order) {
      if (seen[i]) continue;
      seen[i] = true;
      if (closed) break;
      if (i != mi && mirrors.get(i).kind == MirrorKind.HTTP && inBackoff(i)) continue;
      Result r = fetch(i, "blobs/" + sha, "", dl);
      String name = mirrors.get(i).cfg.name();
      if (r.kind() != Transport.Kind.OK) {
        if (i == mi) errors.append(name).append(": ").append(r.error()).append("; ");
        continue;
      }
      if (!Templates.sha256Hex(r.body()).equals(sha)) {
        String msg = "blob " + sha.substring(0, 12) + " failed sha256 verification";
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("kyp.mirror", name);
        a.put("kyp.source", mirrors.get(i).source);
        a.put("kyp.blob.sha256", sha);
        event("kyp.hash_mismatch", a);
        log(LogLevel.WARN, name + ": " + msg + " (discarded)");
        errors.append(name).append(": ").append(msg).append("; ");
        continue;
      }
      try {
        return Transport.utf8(r.body());
      } catch (CharacterCodingException e) {
        errors.append(name).append(": blob ").append(sha, 0, 12).append(" is not UTF-8; ");
      }
    }
    err.setLength(0);
    err.append("blob ").append(sha, 0, 12).append(" unavailable");
    if (errors.length() > 0) err.append(" (").append(errors, 0, errors.length() - 2).append(")");
    return null;
  }

  private State build(int mi, Manifest man, byte[] raw, State cur, long dl, Candidate out) {
    List<Prompt> prompts = new ArrayList<>(man.prompts.size());
    Map<String, String> fetched = new HashMap<>();
    StringBuilder err = new StringBuilder();
    for (Map.Entry<String, Manifest.Entry> e : man.prompts.entrySet()) {
      Manifest.Entry mp = e.getValue();
      String text = cur == null ? null : cur.bySha.get(mp.sha256());
      if (text == null) text = fetched.get(mp.sha256());
      if (text == null) {
        text = resolveBlob(mi, mp.sha256(), dl, err);
        if (text == null) {
          out.error = err.toString();
          return null;
        }
        fetched.put(mp.sha256(), text);
      }
      List<String> vars = mp.variables().isEmpty() ? Templates.variables(text) : mp.variables();
      prompts.add(new Prompt(e.getKey(), mp.version(), mp.sha256(), vars, text));
    }
    return new State(man, raw, prompts);
  }

  private Outcome tryMirror(int mi, State cur, boolean useEtag, long dl, Candidate out) {
    MirrorRt m = mirrors.get(mi);
    String etag = (useEtag && cur != null) ? m.etag : "";
    Result r = fetch(mi, manifestPath(), etag, dl);
    if (r.kind() == Transport.Kind.NOT_MODIFIED) {
      out.etag = r.etag().isEmpty() ? etag : r.etag();
      return Outcome.UNCHANGED;
    }
    if (r.kind() != Transport.Kind.OK) {
      out.missing = r.kind() == Transport.Kind.NOT_FOUND;
      out.error = out.missing ? "manifest not found (" + r.error() + ")" : r.error();
      return Outcome.FAILED;
    }
    Manifest man;
    try {
      man = Manifest.parse(new String(r.body(), StandardCharsets.UTF_8), app, env);
    } catch (ProtocolException e) {
      out.error = "bad manifest: " + e.getMessage();
      return Outcome.FAILED;
    }
    if (cur != null && man.revision < cur.manifest.revision) {
      out.error = "stale manifest ignored (revision " + man.revision + " < held " + cur.manifest.revision + ")";
      return Outcome.STALE;
    }
    if (cur != null && man.revision == cur.manifest.revision) {
      out.etag = r.etag();
      return Outcome.UNCHANGED;
    }
    State st = build(mi, man, r.body(), cur, dl, out);
    if (st == null) return Outcome.FAILED;
    out.state = st;
    out.etag = r.etag();
    return Outcome.UPDATED;
  }

  // --- disk cache ------------------------------------------------------------------------------

  private Path cacheRootFor(String ws) {
    return cacheDir.resolve(ws).resolve(app).resolve(env);
  }

  /** Finds {@code <cacheDir>/<workspace>/<app>/<env>} holding the highest revision. */
  private void locateCache() {
    if (cacheIdx < 0 || cacheRoot != null) return;
    if (!workspace.isEmpty()) {
      cacheRoot = cacheRootFor(workspace);
      return;
    }
    long best = -1;
    if (!Files.isDirectory(cacheDir)) return;
    try (DirectoryStream<Path> ds = Files.newDirectoryStream(cacheDir)) {
      for (Path ws : ds) {
        Path root = ws.resolve(app).resolve(env);
        Result r = Transport.readFile(root.resolve(manifestPath()));
        if (r.kind() != Transport.Kind.OK) continue;
        try {
          Manifest m = Manifest.parse(new String(r.body(), StandardCharsets.UTF_8), app, env);
          if (m.revision > best) {
            best = m.revision;
            cacheRoot = root;
          }
        } catch (ProtocolException ignored) {
          // a damaged cache is skipped, never served
        }
      }
    } catch (IOException | RuntimeException e) {
      log(LogLevel.DEBUG, "cannot scan disk cache: " + e.getMessage());
    }
  }

  private void writeCache(State st) {
    if (cacheIdx < 0) return;
    Path root = cacheRootFor(st.manifest.workspace);
    try {
      for (Prompt p : st.index.values()) {
        Path blob = root.resolve("blobs").resolve(p.sha256());
        if (!Files.exists(blob)) Transport.atomicWrite(blob, p.text().getBytes(StandardCharsets.UTF_8));
      }
      Path mpath = root.resolve(manifestPath());
      Result existing = Transport.readFile(mpath);
      if (existing.kind() == Transport.Kind.OK) {
        if (Arrays.equals(existing.body(), st.rawManifest)) {
          cacheRoot = root;
          return;
        }
        try {
          Manifest m = Manifest.parse(new String(existing.body(), StandardCharsets.UTF_8), app, env);
          if (m.revision > st.manifest.revision) return;
        } catch (ProtocolException ignored) {
          // overwrite a damaged manifest
        }
      }
      Transport.atomicWrite(mpath, st.rawManifest);
      cacheRoot = root;
    } catch (IOException | RuntimeException e) {
      log(LogLevel.WARN, "disk cache write failed: " + e.getMessage());
    }
  }

  // --- install and notify ----------------------------------------------------------------------

  private void install(State st, int mi, boolean notify) {
    State old = state.getAndSet(st);
    String name = mirrors.get(mi).cfg.name();
    synchronized (statusLock) {
      source = name;
    }
    sourceKind = mirrors.get(mi).source;
    if (!observers.isEmpty()) {
      long changedCount = 0;
      for (Prompt p : st.index.values()) {
        Prompt before = old == null ? null : old.index.get(p.name());
        if (before == null || !before.sha256().equals(p.sha256())) changedCount++;
      }
      if (old != null) for (String n : old.names) if (!st.index.containsKey(n)) changedCount++;
      Map<String, Object> a = new LinkedHashMap<>();
      a.put("kyp.revision.previous", old == null ? 0L : old.manifest.revision);
      a.put("kyp.revision", st.manifest.revision);
      a.put("kyp.prompts.changed", changedCount);
      event("kyp.update", a);
    }
    log(
        LogLevel.INFO,
        "loaded " + what() + " revision " + st.manifest.revision + " (" + st.names.size() + " prompts) from "
            + name);
    if (!notify) return;
    List<String> changed = new ArrayList<>();
    for (Prompt p : st.index.values()) {
      Prompt before = old == null ? null : old.index.get(p.name());
      if (before == null || !before.sha256().equals(p.sha256())) changed.add(p.name());
    }
    if (old != null) for (String n : old.names) if (!st.index.containsKey(n)) changed.add(n);
    Collections.sort(changed);
    synchronized (pending) {
      pending.add(new Update(old == null ? 0 : old.manifest.revision, st.manifest.revision, name, changed));
    }
  }

  private void deliverUpdates() {
    synchronized (deliverLock) {
      List<Update> todo;
      synchronized (pending) {
        if (pending.isEmpty()) return;
        todo = new ArrayList<>(pending);
        pending.clear();
      }
      for (Update u : todo) {
        for (Consumer<Update> l : listeners) {
          try {
            l.accept(u);
          } catch (RuntimeException e) {
            log(LogLevel.ERROR, "update listener threw: " + e);
          }
        }
      }
    }
  }

  // --- start-up --------------------------------------------------------------------------------

  /** Local mirrors only (class path, snapshot, disk cache). Highest revision wins; ties go to the earlier one. */
  private void loadLocal() {
    synchronized (refreshLock) {
      Instant start = Instant.now();
      long startNanos = System.nanoTime();
      roundEvents = new ArrayList<>();
      locateCache();
      State best = null;
      int bestMi = -1;
      boolean anyLocal = false;
      List<String> errs = new ArrayList<>();
      for (int mi = 0; mi < mirrors.size(); mi++) {
        if (mirrors.get(mi).kind == MirrorKind.HTTP) continue;
        anyLocal = true;
        Candidate c = new Candidate();
        Outcome oc = tryMirror(mi, best, false, Long.MAX_VALUE, c);
        if (oc == Outcome.UPDATED) {
          best = c.state;
          bestMi = mi;
        } else if (oc == Outcome.FAILED && !c.missing) {
          recordFail(mi, c.error, false);
          fallback(mi, c.error);
          errs.add(mirrors.get(mi).cfg.name() + ": " + c.error);
        }
      }
      if (best != null) {
        install(best, bestMi, false);
        if (bestMi != cacheIdx) writeCache(best);
      }
      if (anyLocal) { // only a round when there was something local to read
        String err = errs.isEmpty() ? "no local copy" : String.join("; ", errs);
        emitRound("start", start, startNanos, bestMi, 0, best != null, err);
      } else {
        roundEvents = new ArrayList<>();
      }
    }
  }

  /** Nothing local: block on the network for up to {@code startupTimeout}. */
  private void startupFromNetwork() {
    long deadline = System.nanoTime() + startupTimeout.toNanos();
    long delay = 100;
    while (state.get() == null) {
      synchronized (refreshLock) {
        round(true, deadline, "start");
      }
      if (state.get() != null || System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(delay) - deadline >= 0) break;
      try {
        Thread.sleep(delay);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        break;
      }
      delay = Math.min(delay * 2, 1000);
    }
    synchronized (pending) {
      pending.clear(); // the first load is not an "update"
    }
    if (state.get() != null) return;
    String err;
    synchronized (statusLock) {
      err = lastError;
    }
    if (!startEmpty)
      throw new UnavailableException(
          "kyp: could not load " + what() + " within " + startupTimeout.toMillis() + " ms: " + err);
    log(LogLevel.WARN, "starting empty, will keep trying: " + err);
  }

  // --- refresh ---------------------------------------------------------------------------------

  /** One round over the polled mirrors, in order. Caller holds refreshLock. */
  private boolean round(boolean ignoreBackoff, long dl, String trigger) {
    Instant start = Instant.now();
    long startNanos = System.nanoTime();
    roundEvents = new ArrayList<>();
    State cur = state.get();
    List<String> errs = new ArrayList<>();
    List<Integer> skipped = new ArrayList<>();
    boolean answered = false;
    int answeredBy = -1;
    for (int mi : polled) {
      if (closed) break;
      if (!ignoreBackoff && inBackoff(mi)) {
        skipped.add(mi);
        continue;
      }
      if (answered = attempt(mi, cur, dl, errs)) {
        answeredBy = mi;
        break;
      }
    }
    // Everything we tried failed: give the mirrors in backoff a chance too.
    if (!answered) {
      for (int mi : skipped) {
        if (closed) break;
        if (answered = attempt(mi, cur, dl, errs)) {
          answeredBy = mi;
          break;
        }
      }
    }
    String joined = String.join("; ", errs);
    synchronized (statusLock) {
      if (answered) lastSuccess = Instant.now();
      lastError = (!answered && joined.isEmpty()) ? "all mirrors backing off" : joined;
    }
    if (!answered && !closed) log(LogLevel.WARN, "refresh failed, serving what is held: " + joined);
    State now = state.get();
    boolean updated = answered && now != cur;
    String lastErr;
    synchronized (statusLock) {
      lastErr = lastError;
    }
    emitRound(trigger, start, startNanos, answeredBy, cur == null ? 0 : cur.manifest.revision, updated, lastErr);
    return answered;
  }

  private boolean attempt(int mi, State cur, long dl, List<String> errs) {
    Candidate c = new Candidate();
    Outcome oc = tryMirror(mi, cur, true, dl, c);
    MirrorRt m = mirrors.get(mi);
    switch (oc) {
      case UPDATED:
        m.etag = c.etag;
        install(c.state, mi, true);
        writeCache(c.state);
        recordOk(mi);
        return true;
      case UNCHANGED:
        m.etag = c.etag;
        recordOk(mi);
        synchronized (statusLock) {
          if (cur != null) source = m.cfg.name();
        }
        if (cur != null) sourceKind = m.source;
        return true;
      case STALE:
        errs.add(m.cfg.name() + ": " + c.error);
        recordFail(mi, c.error, false);
        fallback(mi, c.error);
        return false;
      default:
        errs.add(m.cfg.name() + ": " + c.error);
        recordFail(mi, c.error, true);
        fallback(mi, c.error);
        return false;
    }
  }

  private long jittered(long ms) {
    return (long) (ms * ThreadLocalRandom.current().nextDouble(0.9, 1.1));
  }

  private void schedule(long delayMs) {
    if (closed) return;
    try {
      exec.schedule(this::tick, delayMs, TimeUnit.MILLISECONDS);
    } catch (RejectedExecutionException ignored) {
      // closed
    }
  }

  private void tick() {
    if (closed) return;
    try {
      synchronized (refreshLock) {
        round(false, Long.MAX_VALUE, "poll");
      }
      deliverUpdates();
    } catch (RuntimeException e) {
      log(LogLevel.ERROR, "refresh error: " + e);
    } finally {
      schedule(jittered(pollMs));
    }
  }

  @Override
  public String toString() {
    Status s = status();
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("app", app);
    m.put("env", env);
    m.put("revision", s.revision());
    m.put("source", s.source());
    return "KeepYourPrompts" + m;
  }
}
