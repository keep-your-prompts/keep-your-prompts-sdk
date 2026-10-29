using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace KeepYourPrompts
{
    /// <summary>
    /// Keep Your Prompts client: serves deployed prompts from memory and keeps them fresh in the background.
    /// <code>
    /// await using var prompts = await KeepYourPromptsClient.FromEnvAsync();   // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
    /// string system = prompts.Render("triage", new Dictionary&lt;string, string&gt; { ["company"] = "Acme" });
    /// </code>
    /// Implements prompt delivery protocol v1: interchangeable mirrors with one layout (embedded snapshot, snapshot
    /// folder, disk cache, CDN, origin, git), a manifest plus content-addressed blobs verified with SHA-256, ETag
    /// revalidation, a background refresh loop and an atomic in-memory swap. Reads (<see cref="Get"/>,
    /// <see cref="Render"/>, <see cref="Prompt"/>) never do I/O and are safe from any number of threads.
    /// </summary>
    public sealed class KeepYourPromptsClient : IAsyncDisposable, IDisposable
    {
        /// <summary>SDK version.</summary>
        public const string Version = "0.1.0";

        // ------------------------------------------------------------------------------------------
        // State
        // ------------------------------------------------------------------------------------------

        /// <summary>Immutable once published.</summary>
        private sealed class State
        {
            public State(Manifest manifest, byte[] raw, List<Prompt> prompts)
            {
                Manifest = manifest;
                Raw = raw;
                Index = new Dictionary<string, Prompt>(prompts.Count, StringComparer.Ordinal);
                BySha = new Dictionary<string, string>(prompts.Count, StringComparer.Ordinal);
                foreach (var p in prompts)
                {
                    Index[p.Name] = p;
                    BySha[p.Sha256] = p.Text;
                }
                Names = prompts.Select(p => p.Name).ToArray();
            }

            public Manifest Manifest { get; }
            public byte[] Raw { get; }
            public Dictionary<string, Prompt> Index { get; }
            public Dictionary<string, string> BySha { get; }
            public string[] Names { get; }
        }

        private sealed class MirrorRt
        {
            public MirrorRt(Mirror cfg, MirrorKind kind, string shownUrl)
            {
                Cfg = cfg;
                Kind = kind;
                ShownUrl = shownUrl;
            }

            public Mirror Cfg { get; }
            public MirrorKind Kind { get; }
            public string ShownUrl { get; }
            public string ETag = "";        // guarded by _refreshLock
            public int Failures;            // guarded by _statusLock
            public long RetryAt;            // Stopwatch timestamp; 0 = not backing off
            public string LastError = "";
            public DateTimeOffset? LastOk;
        }

        private enum Outcome { Updated, Unchanged, Stale, Failed }

        private sealed class Candidate
        {
            public State? State;
            public string ETag = "";
            public bool Missing;
            public string Error = "";
        }

        // --- configuration -----------------------------------------------------------------------
        private readonly string _app;
        private readonly string _env;
        private readonly string _deliveryKey;
        private readonly string _workspace;
        private readonly string? _cacheDir;
        private readonly long _pollMs;
        private readonly long _maxBackoffMs;
        private readonly TimeSpan _startupTimeout;
        private readonly bool _startEmpty;
        private readonly Action<KypLogLevel, string>? _logger;
        private readonly KypLogLevel _logLevel;

        // --- mirrors -----------------------------------------------------------------------------
        private readonly List<MirrorRt> _mirrors = new List<MirrorRt>();
        private readonly int[] _polled;
        private readonly int _cacheIdx = -1;
        private readonly HttpTransport? _http;

        // --- runtime -----------------------------------------------------------------------------
        private volatile State? _state;
        private readonly SemaphoreSlim _refreshLock = new SemaphoreSlim(1, 1); // one round at a time; guards etags, _cacheRoot
        private string? _cacheRoot;
        private readonly object _statusLock = new object();
        private readonly DateTimeOffset _started = DateTimeOffset.UtcNow;
        private DateTimeOffset? _lastSuccess;
        private string _lastError = "";
        private string _source = "";
        private readonly List<PromptsUpdatedEventArgs> _pending = new List<PromptsUpdatedEventArgs>();
        private readonly object _deliverLock = new object();
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private Task? _loop;
        private int _disposed;
        private static readonly Random Rng = new Random();
        [ThreadStatic] private static bool _inHandler;

        /// <summary>Raised after a new revision was swapped in, on the refresh loop (or the caller of <see cref="RefreshAsync"/>).</summary>
        public event EventHandler<PromptsUpdatedEventArgs>? Updated;

        private KeepYourPromptsClient(KeepYourPromptsOptions o, bool forSnapshot)
        {
            if (o == null) throw new ArgumentNullException(nameof(o));
            if (string.IsNullOrEmpty(o.App)) throw new KypException("kyp: app is not set (KeepYourPromptsOptions.App or KYP_APP)");
            if (!Manifest.IsSlug(o.App)) throw new KypException("kyp: app \"" + o.App + "\" is not a slug ([a-z0-9][a-z0-9-]{0,62})");
            if (!Manifest.IsSlug(o.Env)) throw new KypException("kyp: env \"" + o.Env + "\" is not a slug ([a-z0-9][a-z0-9-]{0,62})");
            _deliveryKey = o.DeliveryKey ?? "";
            foreach (char c in _deliveryKey)
                if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-'))
                    throw new KypException("kyp: the delivery key contains an invalid character");
            _app = o.App;
            _env = o.Env;
            _workspace = o.Workspace ?? "";
            _cacheDir = forSnapshot || string.IsNullOrEmpty(o.CacheDir) ? null : o.CacheDir;
            _pollMs = Math.Max(100, (long)o.PollInterval.TotalMilliseconds);
            _maxBackoffMs = Math.Max(0, (long)o.MaxBackoff.TotalMilliseconds);
            _startupTimeout = o.StartupTimeout;
            _startEmpty = o.StartEmpty;
            _logger = o.Logger;
            _logLevel = o.LogLevel;
            if (_deliveryKey.Length > 0 && !_deliveryKey.StartsWith("kypd_", StringComparison.Ordinal))
                Log(KypLogLevel.Warn, "delivery key does not start with kypd_; check KYP_DELIVERY_KEY");

            // Order: embedded snapshot, snapshot folder, disk cache, CDN, origin, git, extras.
            var rest = new List<Mirror>();
            if (o.Mirrors != null)
            {
                rest.AddRange(o.Mirrors);
            }
            else
            {
                if (!string.IsNullOrEmpty(o.SnapshotDir)) rest.Add(Mirror.File(o.SnapshotDir!, "snapshot"));
                if (_deliveryKey.Length > 0)
                {
                    rest.Add(Mirror.Http(Transport.JoinUrl(o.CdnBase, _deliveryKey), "cdn"));
                    rest.Add(Mirror.Http(Transport.JoinUrl(o.OriginBase, _deliveryKey), "origin"));
                }
                if (!string.IsNullOrEmpty(o.GitMirror)) rest.Add(Mirror.Http(o.GitMirror!, "git", o.GitToken));
            }
            rest.AddRange(o.ExtraMirrors);
            if (o.EmbeddedSnapshot != null && !forSnapshot) Add(o.EmbeddedSnapshot);
            bool cacheAdded = false;
            foreach (var m in rest)
            {
                var k = Transport.KindOf(m.Url);
                if (k == MirrorKind.Embedded && (forSnapshot || m.Assembly == null)) continue;
                if (!cacheAdded && _cacheDir != null && k == MirrorKind.Http)
                {
                    _cacheIdx = AddCache();
                    cacheAdded = true;
                }
                Add(m);
            }
            if (!cacheAdded && _cacheDir != null) _cacheIdx = AddCache();

            var polled = new List<int>();
            for (int i = 0; i < _mirrors.Count; i++) if (_mirrors[i].Kind == MirrorKind.Http) polled.Add(i);
            if (polled.Count == 0)
            {
                // No network mirrors: poll the file mirrors (a snapshot folder kept fresh by a sidecar or git pull).
                for (int i = 0; i < _mirrors.Count; i++) if (_mirrors[i].Kind == MirrorKind.File) polled.Add(i);
            }
            else
            {
                _http = new HttpTransport(o.ConnectTimeout, o.RequestTimeout, o.UserAgent, o.HttpHandlerFactory);
            }
            _polled = polled.ToArray();
        }

        private void Add(Mirror m) => _mirrors.Add(new MirrorRt(m, Transport.KindOf(m.Url), Redact(m.Url)));

        private int AddCache()
        {
            _mirrors.Add(new MirrorRt(new Mirror("disk-cache", _cacheDir!), MirrorKind.Cache, _cacheDir!));
            return _mirrors.Count - 1;
        }

        private string ManifestPath => "envs/" + _app + "/" + _env + ".json";
        private string What => _app + "/" + _env;

        // ------------------------------------------------------------------------------------------
        // Creation
        // ------------------------------------------------------------------------------------------

        /// <summary>Creates a client from <c>KYP_*</c> environment variables.</summary>
        public static Task<KeepYourPromptsClient> FromEnvAsync(CancellationToken cancellationToken = default) =>
            CreateAsync(KeepYourPromptsOptions.FromEnvironment(), cancellationToken);

        /// <summary>
        /// Loads prompts: local mirrors first (no network); if none holds them, waits on the network for up to
        /// <see cref="KeepYourPromptsOptions.StartupTimeout"/>, then throws <see cref="UnavailableException"/>
        /// (or starts empty with <see cref="KeepYourPromptsOptions.StartEmpty"/>).
        /// </summary>
        public static async Task<KeepYourPromptsClient> CreateAsync(KeepYourPromptsOptions options, CancellationToken cancellationToken = default)
        {
            var c = new KeepYourPromptsClient(options, false);
            try
            {
                await c.StartAsync(cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                await c.DisposeAsync().ConfigureAwait(false);
                throw;
            }
            return c;
        }

        /// <summary>Synchronous <see cref="CreateAsync"/>, for DI factories and static initialisers.</summary>
        public static KeepYourPromptsClient Create(KeepYourPromptsOptions options) =>
            Task.Run(() => CreateAsync(options)).GetAwaiter().GetResult();

        private async Task StartAsync(CancellationToken ct)
        {
            await LoadLocalAsync().ConfigureAwait(false);
            bool loadedLocally = _state != null;
            if (!loadedLocally)
            {
                if (_polled.Length == 0)
                {
                    if (!_startEmpty)
                        throw new UnavailableException("kyp: no prompts for " + What +
                            ": no snapshot or disk cache found and no remote mirror configured " +
                            "(set KYP_DELIVERY_KEY, KYP_SNAPSHOT_DIR or an embedded snapshot)");
                    Log(KypLogLevel.Warn, "starting empty: no mirror for " + What);
                }
                else
                {
                    await StartupFromNetworkAsync(ct).ConfigureAwait(false);
                }
            }
            if (_polled.Length > 0)
            {
                bool immediate = loadedLocally || _state == null;
                _loop = Task.Run(() => RunAsync(immediate));
            }
        }

        // ------------------------------------------------------------------------------------------
        // Reads: one volatile load and a dictionary lookup, no I/O.
        // ------------------------------------------------------------------------------------------

        private Prompt Find(string name)
        {
            var s = _state;
            if (s != null && s.Index.TryGetValue(name, out var p)) return p;
            throw new PromptNotFoundException(name, s != null ? What + " revision " + s.Manifest.Revision : "nothing loaded for " + What);
        }

        /// <summary>The raw template. Throws <see cref="PromptNotFoundException"/>.</summary>
        public string Get(string name) => Find(name).Text;

        /// <summary>The raw template, if the name is deployed.</summary>
        public bool TryGet(string name, out string text)
        {
            var s = _state;
            if (s != null && s.Index.TryGetValue(name, out var p))
            {
                text = p.Text;
                return true;
            }
            text = "";
            return false;
        }

        /// <summary>Whether the name is deployed.</summary>
        public bool Contains(string name) => _state?.Index.ContainsKey(name) ?? false;

        /// <summary>Name, version, sha256, variables and text. Throws <see cref="PromptNotFoundException"/>.</summary>
        public Prompt Prompt(string name) => Find(name);

        /// <summary>Renders a prompt. Throws <see cref="PromptNotFoundException"/> or <see cref="MissingVariableException"/>.</summary>
        public string Render(string name, IReadOnlyDictionary<string, string>? vars, OnMissing onMissing = OnMissing.Error) =>
            Templates.Render(Find(name).Text, vars, onMissing);

        /// <summary>Prompt names in the current revision, sorted (ordinal).</summary>
        public IReadOnlyList<string> Names => _state?.Names ?? Array.Empty<string>();

        /// <summary>Current revision; 0 when nothing is loaded.</summary>
        public long Revision => _state?.Manifest.Revision ?? 0;

        /// <summary>Health, for logs, metrics and readiness probes.</summary>
        public ClientStatus Status
        {
            get
            {
                var s = _state;
                lock (_statusLock)
                {
                    var ms = _mirrors.Select(m => new MirrorStatus(m.Cfg.Name, m.ShownUrl, m.Failures, m.LastError, m.LastOk)).ToArray();
                    var since = _lastSuccess ?? _started;
                    var stale = DateTimeOffset.UtcNow - since;
                    if (stale < TimeSpan.Zero) stale = TimeSpan.Zero;
                    return new ClientStatus(s != null, _source, s?.Manifest.Revision ?? 0, s?.Manifest.Workspace ?? "",
                        s?.Manifest.DeployedAt ?? "", s?.Names.Length ?? 0, _lastSuccess, _lastError, stale, ms);
                }
            }
        }

        /// <summary>
        /// Revalidates now across the network mirrors, ignoring backoff. Completes after at most one round of
        /// requests. Returns true if a mirror answered.
        /// </summary>
        public async Task<bool> RefreshAsync(CancellationToken cancellationToken = default)
        {
            if (_polled.Length == 0 || Volatile.Read(ref _disposed) != 0) return false;
            bool ok;
            using (var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _cts.Token))
            {
                await _refreshLock.WaitAsync(linked.Token).ConfigureAwait(false);
                try
                {
                    ok = await RoundAsync(true, DateTime.MaxValue, linked.Token).ConfigureAwait(false);
                }
                finally
                {
                    _refreshLock.Release();
                }
            }
            DeliverUpdates();
            return ok;
        }

        // ------------------------------------------------------------------------------------------
        // Disposal
        // ------------------------------------------------------------------------------------------

        /// <summary>Stops the refresh loop. Reads keep working.</summary>
        public async ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
            _cts.Cancel();
            if (_loop != null && !_inHandler)
                await Task.WhenAny(_loop, Task.Delay(TimeSpan.FromSeconds(5))).ConfigureAwait(false);
            _http?.Dispose();
        }

        /// <summary>Stops the refresh loop. Reads keep working.</summary>
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
            _cts.Cancel();
            if (_loop != null && !_inHandler)
            {
                try { _loop.Wait(TimeSpan.FromSeconds(5)); }
                catch (AggregateException) { }
            }
            _http?.Dispose();
        }

        // ------------------------------------------------------------------------------------------
        // Snapshot pulling
        // ------------------------------------------------------------------------------------------

        /// <summary>What <see cref="PullSnapshotAsync"/> wrote.</summary>
        public sealed class SnapshotInfo
        {
            internal SnapshotInfo(string workspace, long revision, int promptCount, int blobsWritten, string source)
            {
                Workspace = workspace;
                Revision = revision;
                PromptCount = promptCount;
                BlobsWritten = blobsWritten;
                Source = source;
            }

            /// <summary>Workspace slug.</summary>
            public string Workspace { get; }
            /// <summary>Revision pulled.</summary>
            public long Revision { get; }
            /// <summary>Number of prompts.</summary>
            public int PromptCount { get; }
            /// <summary>Blobs written (existing identical files are skipped).</summary>
            public int BlobsWritten { get; }
            /// <summary>Mirror that served it.</summary>
            public string Source { get; }
        }

        /// <summary>
        /// Pulls the deployed manifest and its blobs from the network mirrors and writes the layout to
        /// <paramref name="outDir"/> (what <c>kyp pull</c> does), e.g. in a build step that embeds prompts.
        /// </summary>
        public static async Task<SnapshotInfo> PullSnapshotAsync(KeepYourPromptsOptions options, string outDir, CancellationToken cancellationToken = default)
        {
            using (var e = new KeepYourPromptsClient(options, true))
            {
                var errors = new List<string>();
                foreach (int mi in e._polled)
                {
                    var c = new Candidate();
                    var oc = await e.TryMirrorAsync(mi, null, false, DateTime.MaxValue, c, cancellationToken).ConfigureAwait(false);
                    if (oc != Outcome.Updated)
                    {
                        errors.Add(e._mirrors[mi].Cfg.Name + ": " + c.Error);
                        continue;
                    }
                    var st = c.State!;
                    int written = 0;
                    foreach (var p in st.Index.Values)
                    {
                        string blob = Transport.Combine(outDir, "blobs/" + p.Sha256);
                        byte[] data = Encoding.UTF8.GetBytes(p.Text);
                        var existing = Transport.ReadFile(blob);
                        if (existing.Kind == FetchKind.Ok && existing.Body!.SequenceEqual(data)) continue;
                        Transport.AtomicWrite(blob, data);
                        written++;
                    }
                    Transport.AtomicWrite(Transport.Combine(outDir, e.ManifestPath), st.Raw);
                    return new SnapshotInfo(st.Manifest.Workspace, st.Manifest.Revision, st.Names.Length, written, e._mirrors[mi].Cfg.Name);
                }
                if (e._polled.Length == 0) errors.Add("no remote mirror configured (set a delivery key or a mirror)");
                throw new UnavailableException("kyp: could not pull " + e.What + ": " + string.Join("; ", errors));
            }
        }

        // ------------------------------------------------------------------------------------------
        // Logging
        // ------------------------------------------------------------------------------------------

        internal string Redact(string text)
        {
            if (_deliveryKey.Length < 8) return text;
            return text.Replace(_deliveryKey, _deliveryKey.Substring(0, 9) + "...");
        }

        private void Log(KypLogLevel level, string msg)
        {
            if (_logLevel == KypLogLevel.Off || level < _logLevel) return;
            string m = Redact(msg);
            try
            {
                if (_logger != null) _logger(level, m);
                else Console.Error.WriteLine("[kyp] " + level.ToString().ToLowerInvariant() + ": " + m);
            }
            catch (Exception)
            {
                // a broken logger must not break the client
            }
        }

        // ------------------------------------------------------------------------------------------
        // Mirror access
        // ------------------------------------------------------------------------------------------

        private async Task<FetchResult> FetchAsync(int mi, string rel, string etag, DateTime deadline, CancellationToken ct)
        {
            var m = _mirrors[mi];
            FetchResult r;
            switch (m.Kind)
            {
                case MirrorKind.Embedded:
                    r = Transport.ReadResource(m.Cfg.Assembly!, m.Cfg.ResourcePrefix, rel);
                    break;
                case MirrorKind.File:
                    try
                    {
                        r = Transport.ReadFile(Transport.Combine(Transport.FileUrlToPath(m.Cfg.Url), rel));
                    }
                    catch (Exception e) when (e is UriFormatException || e is ArgumentException)
                    {
                        r = FetchResult.Failed("bad file mirror URL: " + e.Message);
                    }
                    break;
                case MirrorKind.Cache:
                    r = _cacheRoot == null ? FetchResult.NotFound("empty") : Transport.ReadFile(Transport.Combine(_cacheRoot, rel));
                    break;
                default:
                    r = _http == null
                        ? FetchResult.Failed("no HTTP client")
                        : await _http.GetAsync(Transport.JoinUrl(m.Cfg.Url, rel), etag, m.Cfg.BearerToken, deadline, ct).ConfigureAwait(false);
                    break;
            }
            return r.Error.Length > 0 ? r.WithError(Redact(r.Error)) : r;
        }

        private static long Now() => Stopwatch.GetTimestamp();

        private static long MsToTicks(long ms) => (long)(ms * (double)Stopwatch.Frequency / 1000.0);

        private static double NextJitter()
        {
            lock (Rng) return 0.9 + Rng.NextDouble() * 0.2;
        }

        private bool InBackoff(int mi)
        {
            lock (_statusLock)
            {
                var m = _mirrors[mi];
                return m.RetryAt != 0 && m.RetryAt - Now() > 0;
            }
        }

        private void RecordOk(int mi)
        {
            bool recovered;
            var m = _mirrors[mi];
            lock (_statusLock)
            {
                recovered = m.Failures > 0;
                m.Failures = 0;
                m.RetryAt = 0;
                m.LastError = "";
                m.LastOk = DateTimeOffset.UtcNow;
            }
            if (recovered) Log(KypLogLevel.Info, m.Cfg.Name + " is answering again");
        }

        private void RecordFail(int mi, string err, bool count)
        {
            int failures = 0;
            var m = _mirrors[mi];
            lock (_statusLock)
            {
                m.LastError = err;
                if (count)
                {
                    failures = ++m.Failures;
                    // Skip the mirror for 0, 1, 3, 7, ... poll intervals, capped at MaxBackoff, with +-10% jitter.
                    long mult = (1L << Math.Min(failures - 1, 20)) - 1;
                    long ms = Math.Min(_pollMs * mult, _maxBackoffMs);
                    long jit = (long)(ms * NextJitter());
                    m.RetryAt = jit <= 0 ? 0 : Now() + MsToTicks(jit);
                }
            }
            Log(failures == 1 ? KypLogLevel.Warn : KypLogLevel.Debug, m.Cfg.Name + ": " + err);
        }

        // ------------------------------------------------------------------------------------------
        // Loading
        // ------------------------------------------------------------------------------------------

        /// <summary>Resolves a blob: disk cache, then the mirror that served the manifest, then every other mirror.</summary>
        private async Task<(string? Text, string Error)> ResolveBlobAsync(int mi, string sha, DateTime dl, CancellationToken ct)
        {
            var order = new List<int>();
            if (_cacheIdx >= 0) order.Add(_cacheIdx);
            order.Add(mi);
            for (int i = 0; i < _mirrors.Count; i++) order.Add(i);
            var seen = new bool[_mirrors.Count];
            var errors = new List<string>();
            foreach (int i in order)
            {
                if (seen[i]) continue;
                seen[i] = true;
                if (ct.IsCancellationRequested) break;
                if (i != mi && _mirrors[i].Kind == MirrorKind.Http && InBackoff(i)) continue;
                var r = await FetchAsync(i, "blobs/" + sha, "", dl, ct).ConfigureAwait(false);
                string name = _mirrors[i].Cfg.Name;
                if (r.Kind != FetchKind.Ok)
                {
                    if (i == mi) errors.Add(name + ": " + r.Error);
                    continue;
                }
                if (Templates.Sha256Hex(r.Body!) != sha)
                {
                    string msg = "blob " + sha.Substring(0, 12) + " failed sha256 verification";
                    Log(KypLogLevel.Warn, name + ": " + msg + " (discarded)");
                    errors.Add(name + ": " + msg);
                    continue;
                }
                if (Transport.TryUtf8(r.Body!, out var text)) return (text, "");
                errors.Add(name + ": blob " + sha.Substring(0, 12) + " is not UTF-8");
            }
            return (null, "blob " + sha.Substring(0, 12) + " unavailable" + (errors.Count > 0 ? " (" + string.Join("; ", errors) + ")" : ""));
        }

        private async Task<State?> BuildAsync(int mi, Manifest man, byte[] raw, State? cur, DateTime dl, Candidate cand, CancellationToken ct)
        {
            var prompts = new List<Prompt>(man.Prompts.Count);
            var fetched = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var kv in man.Prompts)
            {
                var mp = kv.Value;
                string? text = null;
                if (cur != null && cur.BySha.TryGetValue(mp.Sha256, out var held)) text = held;
                if (text == null && fetched.TryGetValue(mp.Sha256, out var f)) text = f;
                if (text == null)
                {
                    var (t, err) = await ResolveBlobAsync(mi, mp.Sha256, dl, ct).ConfigureAwait(false);
                    if (t == null)
                    {
                        cand.Error = err;
                        return null;
                    }
                    text = t;
                    fetched[mp.Sha256] = t;
                }
                var vars = mp.Variables.Count == 0 ? Templates.Variables(text) : mp.Variables;
                prompts.Add(new Prompt(kv.Key, mp.Version, mp.Sha256, vars, text));
            }
            return new State(man, raw, prompts);
        }

        private async Task<Outcome> TryMirrorAsync(int mi, State? cur, bool useEtag, DateTime dl, Candidate cand, CancellationToken ct)
        {
            var m = _mirrors[mi];
            string etag = useEtag && cur != null ? m.ETag : "";
            var r = await FetchAsync(mi, ManifestPath, etag, dl, ct).ConfigureAwait(false);
            if (r.Kind == FetchKind.NotModified)
            {
                cand.ETag = r.ETag.Length == 0 ? etag : r.ETag;
                return Outcome.Unchanged;
            }
            if (r.Kind != FetchKind.Ok)
            {
                cand.Missing = r.Kind == FetchKind.NotFound;
                cand.Error = cand.Missing ? "manifest not found (" + r.Error + ")" : r.Error;
                return Outcome.Failed;
            }
            Manifest man;
            try
            {
                man = Manifest.Parse(r.Body!, _app, _env);
            }
            catch (ProtocolException e)
            {
                cand.Error = "bad manifest: " + e.Message;
                return Outcome.Failed;
            }
            if (cur != null && man.Revision < cur.Manifest.Revision)
            {
                cand.Error = "stale manifest ignored (revision " + man.Revision + " < held " + cur.Manifest.Revision + ")";
                return Outcome.Stale;
            }
            if (cur != null && man.Revision == cur.Manifest.Revision)
            {
                cand.ETag = r.ETag;
                return Outcome.Unchanged;
            }
            var st = await BuildAsync(mi, man, r.Body!, cur, dl, cand, ct).ConfigureAwait(false);
            if (st == null) return Outcome.Failed;
            cand.State = st;
            cand.ETag = r.ETag;
            return Outcome.Updated;
        }

        // --- disk cache ----------------------------------------------------------------------------

        private string CacheRootFor(string ws) => Path.Combine(_cacheDir!, ws, _app, _env);

        /// <summary>Finds &lt;cacheDir&gt;/&lt;workspace&gt;/&lt;app&gt;/&lt;env&gt; holding the highest revision.</summary>
        private void LocateCache()
        {
            if (_cacheIdx < 0 || _cacheRoot != null) return;
            if (_workspace.Length > 0)
            {
                _cacheRoot = CacheRootFor(_workspace);
                return;
            }
            if (!Directory.Exists(_cacheDir)) return;
            long best = -1;
            try
            {
                foreach (var ws in Directory.EnumerateDirectories(_cacheDir!))
                {
                    string root = Path.Combine(ws, _app, _env);
                    var r = Transport.ReadFile(Transport.Combine(root, ManifestPath));
                    if (r.Kind != FetchKind.Ok) continue;
                    try
                    {
                        var m = Manifest.Parse(r.Body!, _app, _env);
                        if (m.Revision > best)
                        {
                            best = m.Revision;
                            _cacheRoot = root;
                        }
                    }
                    catch (ProtocolException)
                    {
                        // a damaged cache is skipped, never served
                    }
                }
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException)
            {
                Log(KypLogLevel.Debug, "cannot scan disk cache: " + e.Message);
            }
        }

        private void WriteCache(State st)
        {
            if (_cacheIdx < 0) return;
            string root = CacheRootFor(st.Manifest.Workspace);
            try
            {
                foreach (var p in st.Index.Values)
                {
                    string blob = Transport.Combine(root, "blobs/" + p.Sha256);
                    if (!File.Exists(blob)) Transport.AtomicWrite(blob, Encoding.UTF8.GetBytes(p.Text));
                }
                string mpath = Transport.Combine(root, ManifestPath);
                var existing = Transport.ReadFile(mpath);
                if (existing.Kind == FetchKind.Ok)
                {
                    if (existing.Body!.SequenceEqual(st.Raw))
                    {
                        _cacheRoot = root;
                        return;
                    }
                    try
                    {
                        if (Manifest.Parse(existing.Body!, _app, _env).Revision > st.Manifest.Revision) return;
                    }
                    catch (ProtocolException)
                    {
                        // overwrite a damaged manifest
                    }
                }
                Transport.AtomicWrite(mpath, st.Raw);
                _cacheRoot = root;
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException)
            {
                Log(KypLogLevel.Warn, "disk cache write failed: " + e.Message);
            }
        }

        // --- install and notify --------------------------------------------------------------------

        private void Install(State st, int mi, bool notify)
        {
            // Single writer (callers hold _refreshLock); readers see the new state through the volatile field.
            var old = _state;
            _state = st;
            string name = _mirrors[mi].Cfg.Name;
            lock (_statusLock) _source = name;
            Log(KypLogLevel.Info, "loaded " + What + " revision " + st.Manifest.Revision + " (" + st.Names.Length + " prompts) from " + name);
            if (!notify) return;
            var changed = new List<string>();
            foreach (var p in st.Index.Values)
            {
                if (old == null || !old.Index.TryGetValue(p.Name, out var before) || before.Sha256 != p.Sha256) changed.Add(p.Name);
            }
            if (old != null) changed.AddRange(old.Names.Where(n => !st.Index.ContainsKey(n)));
            changed.Sort(StringComparer.Ordinal);
            lock (_pending) _pending.Add(new PromptsUpdatedEventArgs(old?.Manifest.Revision ?? 0, st.Manifest.Revision, name, changed));
        }

        private void DeliverUpdates()
        {
            lock (_deliverLock)
            {
                PromptsUpdatedEventArgs[] todo;
                lock (_pending)
                {
                    if (_pending.Count == 0) return;
                    todo = _pending.ToArray();
                    _pending.Clear();
                }
                var handlers = Updated;
                if (handlers == null) return;
                foreach (var u in todo)
                {
                    foreach (EventHandler<PromptsUpdatedEventArgs> h in handlers.GetInvocationList())
                    {
                        _inHandler = true;
                        try
                        {
                            h(this, u);
                        }
                        catch (Exception e)
                        {
                            Log(KypLogLevel.Error, "Updated handler threw: " + e);
                        }
                        finally
                        {
                            _inHandler = false;
                        }
                    }
                }
            }
        }

        // --- start-up ------------------------------------------------------------------------------

        /// <summary>Local mirrors only (embedded, snapshot, disk cache). Highest revision wins; ties go to the earlier one.</summary>
        private async Task LoadLocalAsync()
        {
            await _refreshLock.WaitAsync().ConfigureAwait(false);
            try
            {
                LocateCache();
                State? best = null;
                int bestMi = -1;
                for (int mi = 0; mi < _mirrors.Count; mi++)
                {
                    if (_mirrors[mi].Kind == MirrorKind.Http) continue;
                    var c = new Candidate();
                    var oc = await TryMirrorAsync(mi, best, false, DateTime.MaxValue, c, CancellationToken.None).ConfigureAwait(false);
                    if (oc == Outcome.Updated)
                    {
                        best = c.State;
                        bestMi = mi;
                    }
                    else if (oc == Outcome.Failed && !c.Missing)
                    {
                        RecordFail(mi, c.Error, false);
                    }
                }
                if (best != null)
                {
                    Install(best, bestMi, false);
                    if (bestMi != _cacheIdx) WriteCache(best);
                }
            }
            finally
            {
                _refreshLock.Release();
            }
        }

        /// <summary>Nothing local: wait on the network for up to the start-up timeout.</summary>
        private async Task StartupFromNetworkAsync(CancellationToken ct)
        {
            var deadline = DateTime.UtcNow + _startupTimeout;
            int delay = 100;
            while (_state == null)
            {
                await _refreshLock.WaitAsync(ct).ConfigureAwait(false);
                try
                {
                    await RoundAsync(true, deadline, ct).ConfigureAwait(false);
                }
                finally
                {
                    _refreshLock.Release();
                }
                if (_state != null || DateTime.UtcNow.AddMilliseconds(delay) >= deadline) break;
                await Task.Delay(delay, ct).ConfigureAwait(false);
                delay = Math.Min(delay * 2, 1000);
            }
            lock (_pending) _pending.Clear(); // the first load is not an update
            if (_state != null) return;
            string err;
            lock (_statusLock) err = _lastError;
            if (!_startEmpty)
                throw new UnavailableException("kyp: could not load " + What + " within " + (long)_startupTimeout.TotalMilliseconds + " ms: " + err);
            Log(KypLogLevel.Warn, "starting empty, will keep trying: " + err);
        }

        // --- refresh -------------------------------------------------------------------------------

        /// <summary>One round over the polled mirrors, in order. Caller holds _refreshLock.</summary>
        private async Task<bool> RoundAsync(bool ignoreBackoff, DateTime dl, CancellationToken ct)
        {
            var cur = _state;
            var errs = new List<string>();
            var skipped = new List<int>();
            bool answered = false;
            foreach (int mi in _polled)
            {
                if (ct.IsCancellationRequested) break;
                if (!ignoreBackoff && InBackoff(mi))
                {
                    skipped.Add(mi);
                    continue;
                }
                if (answered = await AttemptAsync(mi, cur, dl, errs, ct).ConfigureAwait(false)) break;
            }
            // Everything we tried failed: give the mirrors in backoff a chance too.
            if (!answered)
            {
                foreach (int mi in skipped)
                {
                    if (ct.IsCancellationRequested) break;
                    if (answered = await AttemptAsync(mi, cur, dl, errs, ct).ConfigureAwait(false)) break;
                }
            }
            string joined = string.Join("; ", errs);
            lock (_statusLock)
            {
                if (answered) _lastSuccess = DateTimeOffset.UtcNow;
                _lastError = !answered && joined.Length == 0 ? "all mirrors backing off" : joined;
            }
            if (!answered && !ct.IsCancellationRequested) Log(KypLogLevel.Warn, "refresh failed, serving what is held: " + joined);
            return answered;
        }

        private async Task<bool> AttemptAsync(int mi, State? cur, DateTime dl, List<string> errs, CancellationToken ct)
        {
            var c = new Candidate();
            var oc = await TryMirrorAsync(mi, cur, true, dl, c, ct).ConfigureAwait(false);
            var m = _mirrors[mi];
            switch (oc)
            {
                case Outcome.Updated:
                    m.ETag = c.ETag;
                    Install(c.State!, mi, true);
                    WriteCache(c.State!);
                    RecordOk(mi);
                    return true;
                case Outcome.Unchanged:
                    m.ETag = c.ETag;
                    RecordOk(mi);
                    lock (_statusLock) if (cur != null) _source = m.Cfg.Name;
                    return true;
                case Outcome.Stale:
                    errs.Add(m.Cfg.Name + ": " + c.Error);
                    RecordFail(mi, c.Error, false);
                    return false;
                default:
                    errs.Add(m.Cfg.Name + ": " + c.Error);
                    RecordFail(mi, c.Error, true);
                    return false;
            }
        }

        private async Task RunAsync(bool immediate)
        {
            var ct = _cts.Token;
            bool first = immediate;
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    if (!first) await Task.Delay(TimeSpan.FromMilliseconds(_pollMs * NextJitter()), ct).ConfigureAwait(false);
                    first = false;
                    await _refreshLock.WaitAsync(ct).ConfigureAwait(false);
                    try
                    {
                        await RoundAsync(false, DateTime.MaxValue, ct).ConfigureAwait(false);
                    }
                    finally
                    {
                        _refreshLock.Release();
                    }
                    DeliverUpdates();
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception e)
                {
                    Log(KypLogLevel.Error, "refresh error: " + e);
                }
            }
        }

        /// <inheritdoc />
        public override string ToString() => "KeepYourPromptsClient(" + What + ", revision " + Revision + ")";
    }
}
