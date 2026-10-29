using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Xunit;
using static KeepYourPrompts.Tests.TestSupport;

namespace KeepYourPrompts.Tests
{
    /// <summary>
    /// conformance/README.md "Required behaviour" 4 to 12 over HTTP with the exact fixtures, against the in-process
    /// HttpListener fake ("listener") and conformance/fake_cdn.py ("python", when python3 is installed).
    /// </summary>
    public class ConformanceTests
    {
        private const string Key = "kypd_test";
        private const string GitToken = "github_pat_readonly";

        public static IEnumerable<object[]> Kinds() => FakeCdn.Kinds();

        private sealed class Ctx : IAsyncDisposable
        {
            public readonly TempDir Tmp = new TempDir();
            public readonly string Cdn, Origin, Git;
            public IFakeCdn? Server;
            private readonly List<KeepYourPromptsClient> _clients = new List<KeepYourPromptsClient>();

            public Ctx(string kind)
            {
                Cdn = Tmp.Sub("cdn");
                Origin = Tmp.Sub("origin");
                Git = Tmp.Sub("git");
                foreach (var d in new[] { Cdn, Origin, Git }) Deploy("v12", d);
                Server = FakeCdn.Start(kind, new Dictionary<string, (string, string)>
                {
                    ["cdn"] = ("/v1/d/" + Key, Cdn),
                    ["origin"] = ("/v1/delivery/" + Key, Origin),
                    ["git"] = ("/acme/prompts/main/.kyp", Git),
                });
            }

            public IFakeCdn S => Server!;

            public KeepYourPromptsOptions Options()
            {
                var o = Quiet();
                o.DeliveryKey = Key;
                o.CdnBase = S.Base + "/v1/d";
                o.OriginBase = S.Base + "/v1/delivery";
                o.GitMirror = S.Base + "/acme/prompts/main/.kyp";
                o.GitToken = GitToken;
                o.PollInterval = TimeSpan.FromHours(1); // tests drive RefreshAsync themselves
                return o;
            }

            public async Task<KeepYourPromptsClient> Start(KeepYourPromptsOptions o)
            {
                var c = await KeepYourPromptsClient.CreateAsync(o);
                _clients.Add(c);
                return c;
            }

            public async ValueTask DisposeAsync()
            {
                foreach (var c in _clients) await c.DisposeAsync();
                Server?.Dispose();
                Tmp.Dispose();
            }
        }

        [Theory, MemberData(nameof(Kinds))]
        public async Task HashCheck_TamperedBlobIsRejected(string kind)
        {
            await using var t = new Ctx(kind);
            var c = await t.Start(t.Options());
            Assert.Equal(12, c.Revision);
            Deploy("tampered-v14", t.Cdn);
            Assert.True(await c.RefreshAsync(), "origin still answers");
            Assert.Equal(12, c.Revision);
            Assert.Equal(GreetingV4, c.Get("greeting"));
            Assert.Contains("sha256", c.Status.Mirrors.Single(m => m.Name == "cdn").LastError);

            t.S.Down("origin");
            t.S.Down("git");
            Assert.False(await c.RefreshAsync());
            Assert.Equal(12, c.Revision);
            Assert.Contains("failed sha256 verification", c.Status.LastError);
        }

        [Theory, MemberData(nameof(Kinds))]
        public async Task HashCheck_TamperedMirrorCannotBeStartupSource(string kind)
        {
            await using var t = new Ctx(kind);
            foreach (var d in new[] { t.Cdn, t.Origin, t.Git }) Deploy("tampered-v14", d);
            var o = t.Options();
            o.StartupTimeout = TimeSpan.FromMilliseconds(300);
            await Assert.ThrowsAsync<UnavailableException>(() => t.Start(o));
        }

        [Theory, MemberData(nameof(Kinds))]
        public async Task MirrorOrderAndFallback(string kind)
        {
            await using var t = new Ctx(kind);
            var c = await t.Start(t.Options());
            Assert.Equal("cdn", c.Status.Source);
            Assert.Equal(0, t.S.Stat("origin", "200"));
            Assert.Equal(0, t.S.Stat("git", "200"));
            Assert.Null(t.S.Auth("cdn"));

            t.S.Down("cdn");
            Assert.True(await c.RefreshAsync());
            Assert.Equal("origin", c.Status.Source);
            Assert.Contains("cdn: HTTP 503", c.Status.LastError);
            Assert.Equal(0, t.S.Stat("git", "200") + t.S.Stat("git", "304"));

            t.S.Down("origin");
            Assert.True(await c.RefreshAsync());
            Assert.Equal("git", c.Status.Source);
            Assert.Equal("Bearer " + GitToken, t.S.Auth("git"));
            Assert.Equal(GreetingV4, c.Get("greeting"));

            t.S.Up("cdn");
            t.S.Up("origin");
            Assert.True(await c.RefreshAsync());
            Assert.Equal("cdn", c.Status.Source);
            Assert.Equal("", c.Status.LastError);
        }

        [Theory, MemberData(nameof(Kinds))]
        public async Task DeliveryKeyIsRedacted(string kind)
        {
            await using var t = new Ctx(kind);
            var o = t.Options();
            o.DeliveryKey = "kypd_Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4f";
            o.StartupTimeout = TimeSpan.FromMilliseconds(200);
            o.StartEmpty = true;
            var c = await t.Start(o);
            foreach (var m in c.Status.Mirrors) Assert.DoesNotContain("Ab3dEf6hIj9l", m.Url);
            Assert.DoesNotContain("Ab3dEf6hIj9l", c.Status.LastError);
        }

        [Theory, MemberData(nameof(Kinds))]
        public async Task Revalidation_SendsIfNoneMatch_304ChangesNothing(string kind)
        {
            await using var t = new Ctx(kind);
            var c = await t.Start(t.Options());
            int updates = 0;
            c.Updated += (_, _) => Interlocked.Increment(ref updates);
            int downloads = t.S.Stat("cdn", "200");
            Assert.Equal(0, t.S.Stat("cdn", "304"));
            Assert.True(await c.RefreshAsync());
            Assert.Equal(1, t.S.Stat("cdn", "304"));
            Assert.True(await c.RefreshAsync());
            Assert.Equal(2, t.S.Stat("cdn", "304"));
            Assert.Equal(downloads, t.S.Stat("cdn", "200"));
            Assert.Equal(12, c.Revision);
            Assert.Equal(0, updates);
            Assert.NotNull(c.Status.LastSuccess);
        }

        [Theory, MemberData(nameof(Kinds))]
        public async Task HotUpdate_OneRefresh_CallbackOnce(string kind)
        {
            await using var t = new Ctx(kind);
            var c = await t.Start(t.Options());
            var updates = new ConcurrentQueue<PromptsUpdatedEventArgs>();
            c.Updated += (_, e) => updates.Enqueue(e);
            Assert.Equal(4, c.Prompt("greeting").Version);
            Deploy("v13", t.Cdn);
            Assert.True(await c.RefreshAsync());
            Assert.Equal(13, c.Revision);
            Assert.Equal(5, c.Prompt("greeting").Version);
            Assert.Equal(GreetingV5, c.Get("greeting"));
            Assert.Equal("Hi Ana! Acme is glad you are here.",
                c.Render("greeting", new Dictionary<string, string> { ["name"] = "Ana", ["company"] = "Acme" }));
            Assert.True(await c.RefreshAsync());
            var u = Assert.Single(updates);
            Assert.Equal(12, u.OldRevision);
            Assert.Equal(13, u.NewRevision);
            Assert.Equal("cdn", u.Source);
            Assert.Equal(new[] { "greeting" }, u.Changed);
        }

        [Theory, MemberData(nameof(Kinds))]
        public async Task HotUpdate_InBackground(string kind)
        {
            await using var t = new Ctx(kind);
            var o = t.Options();
            o.PollInterval = TimeSpan.FromMilliseconds(100);
            var c = await t.Start(o);
            var fired = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            c.Updated += (_, _) => fired.TrySetResult(true);
            Deploy("v13", t.Cdn);
            Assert.Same(fired.Task, await Task.WhenAny(fired.Task, Task.Delay(5000)));
            Assert.Equal(GreetingV5, c.Get("greeting"));
        }

        [Theory, MemberData(nameof(Kinds))]
        public async Task StaleMirror_NeverReplacesRevision12(string kind)
        {
            await using var t = new Ctx(kind);
            var c = await t.Start(t.Options());
            Deploy("v11-stale", t.Cdn);
            t.S.Down("origin");
            t.S.Down("git");
            Assert.False(await c.RefreshAsync());
            Assert.Equal(12, c.Revision);
            Assert.Equal(GreetingV4, c.Get("greeting"));
            Assert.Contains("stale manifest ignored", c.Status.LastError);
        }

        [Theory, MemberData(nameof(Kinds))]
        public async Task FailuresNeverEvict(string kind)
        {
            await using var t = new Ctx(kind);
            var c = await t.Start(t.Options());
            foreach (var r in new[] { "cdn", "origin", "git" }) t.S.Down(r);
            await Task.Delay(30);
            Assert.False(await c.RefreshAsync());
            Assert.Equal(GreetingV4, c.Get("greeting"));
            var st = c.Status;
            Assert.True(st.Ready);
            Assert.Equal(12, st.Revision);
            Assert.Contains("cdn: HTTP 503", st.LastError);
            Assert.Contains("origin: HTTP 503", st.LastError);
            Assert.Contains("git: HTTP 503", st.LastError);
            Assert.True(st.StaleFor >= TimeSpan.FromMilliseconds(25), st.StaleFor.ToString());
            Assert.True(st.Mirrors.Single(m => m.Name == "cdn").ConsecutiveFailures >= 1);

            t.Server!.Dispose();
            t.Server = null;
            Assert.False(await c.RefreshAsync());
            Assert.Equal(GreetingV4, c.Get("greeting"));
        }

        [Theory, MemberData(nameof(Kinds))]
        public async Task Startup_NothingReachable_TimesOutOrStartsEmpty(string kind)
        {
            await using var t = new Ctx(kind);
            foreach (var r in new[] { "cdn", "origin", "git" }) t.S.Down(r);
            var o = t.Options();
            o.StartupTimeout = TimeSpan.FromMilliseconds(400);
            var sw = System.Diagnostics.Stopwatch.StartNew();
            await Assert.ThrowsAsync<UnavailableException>(() => t.Start(o));
            Assert.InRange(sw.ElapsedMilliseconds, 250, 3000);

            o = t.Options();
            o.StartupTimeout = TimeSpan.FromMilliseconds(200);
            o.StartEmpty = true;
            o.PollInterval = TimeSpan.FromMilliseconds(100);
            o.MaxBackoff = TimeSpan.FromMilliseconds(200);
            var c = await t.Start(o);
            Assert.False(c.Status.Ready);
            Assert.False(c.TryGet("greeting", out _));
            Assert.Throws<PromptNotFoundException>(() => c.Get("greeting"));
            t.S.Up("origin");
            Assert.True(await Eventually(() => c.TryGet("greeting", out _), TimeSpan.FromSeconds(5)));
            Assert.Equal("origin", c.Status.Source);
        }

        [Theory, MemberData(nameof(Kinds))]
        public async Task DiskCache_NewClientStartsFromIt(string kind)
        {
            await using var t = new Ctx(kind);
            string cache = t.Tmp.Sub("cache");
            var o = t.Options();
            o.CacheDir = cache;
            var first = await t.Start(o);
            Assert.Equal(12, first.Revision);
            await first.DisposeAsync();
            Assert.True(File.Exists(Path.Combine(cache, "acme", "demo", "prod", "envs", "demo", "prod.json")));

            var offlineOpts = Quiet();
            offlineOpts.CacheDir = cache;
            var offline = await t.Start(offlineOpts);
            Assert.Equal("disk-cache", offline.Status.Source);
            Assert.Equal(GreetingV4, offline.Get("greeting"));

            foreach (var r in new[] { "cdn", "origin", "git" }) t.S.Down(r);
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var down = await t.Start(o);
            Assert.True(sw.ElapsedMilliseconds < 1000);
            Assert.Equal(GreetingV4, down.Get("greeting"));
            Assert.Equal("disk-cache", down.Status.Source);
        }

        [Theory, MemberData(nameof(Kinds))]
        public async Task DiskCache_FollowsHotUpdates(string kind)
        {
            await using var t = new Ctx(kind);
            string cache = t.Tmp.Sub("cache");
            var o = t.Options();
            o.CacheDir = cache;
            var c = await t.Start(o);
            Deploy("v13", t.Cdn);
            Assert.True(await c.RefreshAsync());
            await c.DisposeAsync();
            var offlineOpts = Quiet();
            offlineOpts.CacheDir = cache;
            var offline = await t.Start(offlineOpts);
            Assert.Equal(13, offline.Revision);
            Assert.Equal(GreetingV5, offline.Get("greeting"));
        }

        [Theory, MemberData(nameof(Kinds))]
        public async Task ReadPath_SafeFromManyThreadsDuringSwaps(string kind)
        {
            await using var t = new Ctx(kind);
            var c = await t.Start(t.Options());
            using var stop = new CancellationTokenSource();
            long reads = 0;
            var vars = new Dictionary<string, string> { ["company"] = "Acme" };
            // Dedicated threads (not pool tasks), so the readers cannot starve the refresh's own I/O continuations.
            var workers = Enumerable.Range(0, 8).Select(_ => Task.Factory.StartNew(() =>
            {
                while (!stop.IsCancellationRequested)
                {
                    string g = c.Get("greeting");
                    if (g != GreetingV4 && g != GreetingV5) throw new Exception("unexpected: " + g);
                    var p = c.Prompt("greeting");
                    if (Templates.Sha256Hex(p.Text) != p.Sha256) throw new Exception("torn read");
                    c.Render("triage", vars);
                    Interlocked.Increment(ref reads);
                }
            }, TaskCreationOptions.LongRunning)).ToArray();
            await Task.Delay(100);
            Deploy("v13", t.Cdn);
            Assert.True(await c.RefreshAsync());
            await Task.Delay(100);
            stop.Cancel();
            await Task.WhenAll(workers);
            Assert.True(Interlocked.Read(ref reads) > 1000, "reads: " + reads);
            Assert.Equal(GreetingV5, c.Get("greeting"));
        }
    }
}
