using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Xunit;
using static KeepYourPrompts.Tests.TestSupport;

namespace KeepYourPrompts.Tests
{
    public class UnitTests
    {
        private static KeepYourPromptsOptions Snapshot(string fixture)
        {
            var o = Quiet();
            o.SnapshotDir = Fixture(fixture);
            return o;
        }

        [Fact(DisplayName = "5. start from local: snapshot folder, no network, greeting v4 at once")]
        public async Task StartFromSnapshot()
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            await using var c = await KeepYourPromptsClient.CreateAsync(Snapshot("v12"));
            Assert.True(sw.ElapsedMilliseconds < 1000);
            var p = c.Prompt("greeting");
            Assert.Equal(4, p.Version);
            Assert.Equal(GreetingV4, p.Text);
            Assert.Equal(new[] { "name", "company" }, p.Variables);
            Assert.Equal("Hello Ana, welcome to Acme.", c.Render("greeting", new Dictionary<string, string> { ["name"] = "Ana", ["company"] = "Acme" }));
            Assert.Equal("snapshot", c.Status.Source);
            Assert.Equal(new[] { "agents/reviewer", "empty", "greeting", "triage" }, c.Names);
            Assert.Equal("Review the diff.", c.Get("agents/reviewer"));
            Assert.Equal("", c.Get("empty"));
            Assert.Equal("You are a support agent for Acme. Literal {{braces}} stay.", c.Render("triage", new Dictionary<string, string> { ["company"] = "Acme" }));
            Assert.Equal("acme", c.Status.Workspace);
        }

        [Fact(DisplayName = "4. hash check: a tampered snapshot is refused")]
        public async Task TamperedSnapshot()
        {
            var o = Snapshot("tampered-v14");
            o.StartupTimeout = TimeSpan.FromMilliseconds(200);
            var e = await Assert.ThrowsAsync<UnavailableException>(() => KeepYourPromptsClient.CreateAsync(o));
            Assert.Contains("sha256", e.Message);
        }

        [Fact(DisplayName = "9. stale local copies: highest revision wins at start-up")]
        public async Task HighestLocalRevisionWins()
        {
            using var t = new TempDir();
            var o = Snapshot("v13");
            o.CacheDir = t.Sub("cache");
            await using (var c = await KeepYourPromptsClient.CreateAsync(o)) Assert.Equal(13, c.Revision);
            o = Snapshot("v11-stale");
            o.CacheDir = t.Sub("cache");
            await using (var c = await KeepYourPromptsClient.CreateAsync(o))
            {
                Assert.Equal(13, c.Revision);
                Assert.Equal("disk-cache", c.Status.Source);
            }
        }

        [Fact(DisplayName = "snapshot folder kept fresh by a sidecar is picked up live")]
        public async Task PollsSnapshotFolder()
        {
            using var t = new TempDir();
            string dir = t.Sub("snap");
            Deploy("v12", dir);
            var o = Quiet();
            o.SnapshotDir = dir;
            o.PollInterval = TimeSpan.FromMilliseconds(100);
            await using var c = await KeepYourPromptsClient.CreateAsync(o);
            var updates = new ConcurrentQueue<PromptsUpdatedEventArgs>();
            c.Updated += (_, e) => updates.Enqueue(e);
            Deploy("v13", dir);
            Assert.True(await Eventually(() => c.Revision == 13, TimeSpan.FromSeconds(5)));
            Assert.Equal(GreetingV5, c.Get("greeting"));
            Assert.True(await Eventually(() => updates.Count == 1, TimeSpan.FromSeconds(2)));
        }

        [Fact(DisplayName = "embedded-resource snapshot: starts with zero files and zero network")]
        public async Task EmbeddedSnapshot()
        {
            var o = Quiet().UseEmbeddedSnapshot(typeof(UnitTests).Assembly, "kyp");
            await using var c = await KeepYourPromptsClient.CreateAsync(o);
            Assert.Equal("embedded", c.Status.Source);
            Assert.Equal(GreetingV4, c.Get("greeting"));
            Assert.Equal("", c.Get("empty"));
        }

        [Fact(DisplayName = "KYP_* environment variables")]
        public void FromEnvironment()
        {
            var env = new Dictionary<string, string>
            {
                ["KYP_APP"] = "demo",
                ["KYP_ENV"] = "staging",
                ["KYP_DELIVERY_KEY"] = "kypd_x",
                ["KYP_SNAPSHOT_DIR"] = "/opt/app/prompts",
                ["KYP_CACHE_DIR"] = "/var/cache/kyp",
                ["KYP_GIT_MIRROR"] = "https://raw.githubusercontent.com/acme/prompts/main/.kyp",
                ["KYP_GIT_TOKEN"] = "t",
                ["KYP_CDN_URL"] = "https://cdn.example/v1/d",
                ["KYP_ORIGIN_URL"] = "https://api.example/v1/delivery",
                ["KYP_POLL_INTERVAL"] = "0.5",
                ["KYP_LOG"] = "off",
                ["KYP_WORKSPACE"] = "acme",
            };
            var o = KeepYourPromptsOptions.FromEnvironment(k => env.TryGetValue(k, out var v) ? v : null);
            Assert.Equal("demo", o.App);
            Assert.Equal("staging", o.Env);
            Assert.Equal("kypd_x", o.DeliveryKey);
            Assert.Equal("/opt/app/prompts", o.SnapshotDir);
            Assert.Equal("/var/cache/kyp", o.CacheDir);
            Assert.Equal("t", o.GitToken);
            Assert.Equal("https://cdn.example/v1/d", o.CdnBase);
            Assert.Equal("https://api.example/v1/delivery", o.OriginBase);
            Assert.Equal(TimeSpan.FromMilliseconds(500), o.PollInterval);
            Assert.Equal(KypLogLevel.Off, o.LogLevel);
            Assert.Equal("acme", o.Workspace);
            var d = KeepYourPromptsOptions.FromEnvironment(_ => null);
            Assert.Equal("prod", d.Env);
            Assert.Equal(KeepYourPromptsOptions.DefaultCdnBase, d.CdnBase);
        }

        [Fact(DisplayName = "errors: not found, missing variables, bad options, nothing configured")]
        public async Task Errors()
        {
            await using (var c = await KeepYourPromptsClient.CreateAsync(Snapshot("v12")))
            {
                var nf = Assert.Throws<PromptNotFoundException>(() => c.Get("nope"));
                Assert.Equal("nope", nf.Name);
                Assert.False(c.TryGet("nope", out _));
                Assert.False(c.Contains("nope"));
                var mv = Assert.Throws<MissingVariableException>(() => c.Render("greeting", new Dictionary<string, string>()));
                Assert.Equal(new[] { "name", "company" }, mv.Names);
                Assert.Equal(GreetingV4, c.Render("greeting", null, OnMissing.Keep));
                Assert.Equal("Hello , welcome to .", c.Render("greeting", null, OnMissing.Empty));
            }
            await Assert.ThrowsAsync<KypException>(() => KeepYourPromptsClient.CreateAsync(new KeepYourPromptsOptions()));
            await Assert.ThrowsAsync<KypException>(() => KeepYourPromptsClient.CreateAsync(new KeepYourPromptsOptions { App = "Bad App" }));
            var badKey = Quiet();
            badKey.DeliveryKey = "kypd_bad/key";
            await Assert.ThrowsAsync<KypException>(() => KeepYourPromptsClient.CreateAsync(badKey));
            await Assert.ThrowsAsync<UnavailableException>(() => KeepYourPromptsClient.CreateAsync(Quiet()));
            var emptyOpts = Quiet();
            emptyOpts.StartEmpty = true;
            await using var empty = await KeepYourPromptsClient.CreateAsync(emptyOpts);
            Assert.False(empty.Status.Ready);
            Assert.Equal(0, empty.Revision);
            Assert.False(await empty.RefreshAsync());
        }

        [Fact(DisplayName = "manifest for another app/env or malformed JSON is rejected")]
        public void WrongApp()
        {
            byte[] text = File.ReadAllBytes(Path.Combine(Fixture("v12"), "envs", "demo", "prod.json"));
            Assert.Throws<ProtocolException>(() => Manifest.Parse(text, "other", "prod"));
            Assert.Throws<ProtocolException>(() => Manifest.Parse(text, "demo", "staging"));
            Assert.Throws<ProtocolException>(() => Manifest.Parse(Encoding.UTF8.GetBytes("[]"), "demo", "prod"));
            Assert.Throws<ProtocolException>(() => Manifest.Parse(Encoding.UTF8.GetBytes("{"), "demo", "prod"));
            Assert.Throws<ProtocolException>(() => Manifest.Parse(Encoding.UTF8.GetBytes(
                "{\"schema\":1.0,\"workspace\":\"a\",\"app\":\"demo\",\"env\":\"prod\",\"revision\":1,\"prompts\":{}}"), "demo", "prod"));
        }

        [Fact(DisplayName = "PullSnapshotAsync writes a complete mirror")]
        public async Task PullSnapshot()
        {
            using var t = new TempDir();
            string outDir = t.Sub("out");
            using (var s = new ListenerFakeCdn(new Dictionary<string, (string, string)> { ["cdn"] = ("/v1/d/kypd_test", Fixture("v13")) }))
            {
                var o = Quiet();
                o.DeliveryKey = "kypd_test";
                o.CdnBase = s.Base + "/v1/d";
                o.OriginBase = s.Base + "/none";
                var info = await KeepYourPromptsClient.PullSnapshotAsync(o, outDir);
                Assert.Equal(13, info.Revision);
                Assert.Equal(4, info.BlobsWritten);
                Assert.Equal("cdn", info.Source);
            }
            var so = Quiet();
            so.SnapshotDir = outDir;
            await using var c = await KeepYourPromptsClient.CreateAsync(so);
            Assert.Equal(GreetingV5, c.Get("greeting"));
        }

        [Fact(DisplayName = "Dispose is idempotent and reads keep working; sync Create works")]
        public async Task DisposeTwice()
        {
            var c = KeepYourPromptsClient.Create(Snapshot("v12"));
            c.Dispose();
            await c.DisposeAsync();
            Assert.Equal(GreetingV4, c.Get("greeting"));
            Assert.False(await c.RefreshAsync());
        }

        [Fact(DisplayName = "AddKeepYourPrompts registers a singleton disposed with the container")]
        public async Task DependencyInjection()
        {
            var logs = new ConcurrentQueue<string>();
            var services = new ServiceCollection();
            services.AddKeepYourPrompts(o =>
            {
                o.App = "demo";
                o.SnapshotDir = Fixture("v12");
                o.Logger = (level, msg) => logs.Enqueue(level + " " + msg);
                o.LogLevel = KypLogLevel.Info;
            });
            await using var sp = services.BuildServiceProvider();
            var a = sp.GetRequiredService<KeepYourPromptsClient>();
            var b = sp.GetRequiredService<KeepYourPromptsClient>();
            Assert.Same(a, b);
            Assert.Equal(GreetingV4, a.Get("greeting"));
            Assert.Contains(logs, l => l.Contains("loaded demo/prod revision 12"));
        }
    }
}
