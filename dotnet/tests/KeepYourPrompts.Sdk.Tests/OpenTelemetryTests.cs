using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading.Tasks;
using KeepYourPrompts.OpenTelemetry;
using global::OpenTelemetry;
using global::OpenTelemetry.Metrics;
using global::OpenTelemetry.Trace;
using Xunit;
using static KeepYourPrompts.Tests.TestSupport;

namespace KeepYourPrompts.Tests
{
    /// <summary>protocol/tracing.md conformance checklist, with in-memory OpenTelemetry exporters.</summary>
    [Collection("otel")] // ActivitySource listeners are process-wide: run these one at a time
    public class OpenTelemetryTests
    {
        private const string Key = "kypd_test";
        private const string GreetingSha = "5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d";

        private sealed class Tel : IDisposable
        {
            public readonly List<Activity> Spans = new List<Activity>();
            public readonly List<Metric> Metrics = new List<Metric>();
            public readonly TracerProvider Tracer;
            public readonly MeterProvider Meter;
            public readonly ActivitySource App = new ActivitySource("test-app");

            public Tel()
            {
                Tracer = Sdk.CreateTracerProviderBuilder().AddKeepYourPromptsInstrumentation().AddSource("test-app").AddInMemoryExporter(Spans).Build()!;
                Meter = Sdk.CreateMeterProviderBuilder().AddKeepYourPromptsInstrumentation().AddInMemoryExporter(Metrics).Build()!;
            }

            public List<Activity> Named(string n) => Spans.Where(s => s.DisplayName == n).ToList();

            public Dictionary<string, Metric> Collect()
            {
                Metrics.Clear();
                Meter.ForceFlush();
                foreach (var m in Metrics) Assert.Equal("keepyourprompts", m.MeterName);
                return Metrics.GroupBy(m => m.Name).ToDictionary(g => g.Key, g => g.Last());
            }

            public void Dispose()
            {
                Tracer.Dispose();
                Meter.Dispose();
                App.Dispose();
            }
        }

        private static Dictionary<string, object?> Tags(Activity a) => a.TagObjects.ToDictionary(kv => kv.Key, kv => kv.Value);

        private static Dictionary<string, object?> Expected() => new Dictionary<string, object?>
        {
            ["kyp.prompt.name"] = "greeting",
            ["kyp.prompt.version"] = 4L,
            ["kyp.prompt.sha256"] = GreetingSha,
            ["kyp.app"] = "demo",
            ["kyp.env"] = "prod",
            ["kyp.revision"] = 12L,
            ["kyp.workspace"] = "acme",
            ["kyp.source"] = "snapshot",
            ["gen_ai.prompt.name"] = "greeting",
            ["gen_ai.prompt.version"] = "4",
        };

        private static async Task<KeepYourPromptsClient> Local()
        {
            var o = Quiet();
            o.SnapshotDir = Fixture("v12");
            return await KeepYourPromptsClient.CreateAsync(o);
        }

        [Fact]
        public async Task MetaAndRenderWithMeta()
        {
            await using var c = await Local();
            var m = c.Meta("greeting");
            Assert.Equal(Expected().OrderBy(kv => kv.Key), m.Attributes().Select(kv => new KeyValuePair<string, object?>(kv.Key, kv.Value)).OrderBy(kv => kv.Key));
            var r = c.RenderWithMeta("greeting", new Dictionary<string, string> { ["name"] = "Ada", ["company"] = "Acme" });
            Assert.Equal("Hello Ada, welcome to Acme.", r.Text);
            Assert.Equal(m, r.Meta);
            var flat = Expected().Where(kv => !kv.Key.StartsWith("gen_ai", StringComparison.Ordinal)).ToDictionary(kv => kv.Key.Replace('.', '_'), kv => kv.Value);
            foreach (var md in new[] { m.TraceMetadata(), m.LangfuseMetadata(), m.LangSmithMetadata() })
                Assert.Equal(flat.OrderBy(kv => kv.Key), md.Select(kv => new KeyValuePair<string, object?>(kv.Key, kv.Value)).OrderBy(kv => kv.Key));
            Assert.Throws<PromptNotFoundException>(() => c.Meta("nope"));
        }

        [Fact]
        public async Task AnnotateCurrentActivityWithoutContent()
        {
            using var t = new Tel();
            await using var c = await Local();
            using var ins = c.AddOpenTelemetry(new KeepYourPromptsInstrumentationOptions { CaptureContent = false });
            using (t.App.StartActivity("llm.call"))
            {
                Assert.Equal(4, ins.Annotate("greeting", variables: new Dictionary<string, string> { ["name"] = "Ada" }).Version);
            }
            Assert.Equal(Expected().OrderBy(kv => kv.Key), Tags(t.Named("llm.call")[0]).OrderBy(kv => kv.Key));
        }

        [Fact]
        public async Task CaptureContentAndOpenInference()
        {
            using var t = new Tel();
            await using var c = await Local();
            using var ins = c.AddOpenTelemetry(new KeepYourPromptsInstrumentationOptions { CaptureContent = true, OpenInference = true });
            var vars = new Dictionary<string, string> { ["name"] = "Ada", ["company"] = "Acme" };
            using (t.App.StartActivity("llm.call"))
            {
                ins.Annotate(c.RenderWithMeta("greeting", vars), variables: vars);
            }
            var a = Tags(t.Named("llm.call")[0]);
            Assert.Equal("Hello {{name}}, welcome to {{ company }}.", a["kyp.prompt.template"]);
            Assert.Equal("Ada", a["gen_ai.prompt.variable.name"]);
            Assert.Equal("Acme", a["gen_ai.prompt.variable.company"]);
            Assert.Equal("keepyourprompts", a["prompt.vendor"]);
            Assert.Equal("demo/prod/greeting", a["prompt.id"]);
            Assert.Equal("4", a["llm.prompt_template.version"]);
            Assert.Equal("{\"name\":\"Ada\",\"company\":\"Acme\"}", a["llm.prompt_template.variables"]);

            using (var explicitActivity = t.App.StartActivity("explicit"))
            {
                explicitActivity!.SetPromptAttributes(c.Meta("triage"), vars, genAiAttributes: false);
            }
            var b = Tags(t.Named("explicit")[0]);
            Assert.Equal(7L, b["kyp.prompt.version"]);
            Assert.False(b.ContainsKey("gen_ai.prompt.name"));
            Assert.False(b.ContainsKey("gen_ai.prompt.variable.company"));
        }

        [Fact]
        public async Task RefreshActivitiesEventsAndMetrics()
        {
            using var t = new Tel();
            using var tmp = new TempDir();
            string cdn = tmp.Sub("cdn"), origin = tmp.Sub("origin");
            Deploy("v12", cdn);
            Deploy("v12", origin);
            using var s = FakeCdn.Start("listener", new Dictionary<string, (string, string)> { ["cdn"] = ("/v1/d/" + Key, cdn), ["origin"] = ("/v1/delivery/" + Key, origin) });
            using var ins = new KeepYourPromptsInstrumentation();
            var o = Quiet();
            o.DeliveryKey = Key;
            o.CdnBase = s.Base + "/v1/d";
            o.OriginBase = s.Base + "/v1/delivery";
            o.PollInterval = TimeSpan.FromHours(1);
            o.Observers.Add(ins); // sees the start-up round
            await using var c = await KeepYourPromptsClient.CreateAsync(o);
            ins.Attach(c);

            var start = t.Named("kyp.refresh");
            Assert.Single(start);
            Assert.Equal("start", Tags(start[0])["kyp.refresh.trigger"]);
            Assert.Equal("kyp.update", start[0].Events.Single().Name);
            Assert.Equal(default, start[0].ParentSpanId);

            // CDN down: a manual refresh under a parent activity, with a fallback event.
            s.Down("cdn");
            using (var parent = t.App.StartActivity("parent"))
            {
                Assert.True(await c.RefreshAsync());
                var manual = t.Named("kyp.refresh")[1];
                var a = Tags(manual);
                Assert.Equal("manual", a["kyp.refresh.trigger"]);
                Assert.Equal("not_modified", a["kyp.refresh.result"]);
                Assert.Equal("origin", a["kyp.source"]);
                Assert.Equal(12L, a["kyp.revision"]);
                Assert.Equal("acme", a["kyp.workspace"]);
                Assert.Equal(parent!.SpanId, manual.ParentSpanId);
                var fb = manual.Events.Single();
                Assert.Equal("kyp.fallback", fb.Name);
                Assert.Equal("http_503", fb.Tags.First(kv => kv.Key == "error.type").Value);
            }
            Assert.Equal("origin", c.Meta("greeting").Source);

            // Tampered CDN, v13 on the origin: hash mismatch, fallback, update.
            s.Up("cdn");
            Deploy("tampered-v14", cdn);
            Deploy("v13", origin);
            Assert.True(await c.RefreshAsync());
            Assert.Equal(13, c.Revision);
            var upd = t.Named("kyp.refresh")[2];
            Assert.Equal(new[] { "kyp.hash_mismatch", "kyp.fallback", "kyp.update" }, upd.Events.Select(e => e.Name));
            Assert.Equal("blob_unavailable", upd.Events.ElementAt(1).Tags.First(kv => kv.Key == "error.type").Value);

            // Everything down: an error activity.
            s.Down("cdn");
            s.Down("origin");
            Assert.False(await c.RefreshAsync());
            var failed = t.Named("kyp.refresh")[3];
            Assert.Equal(ActivityStatusCode.Error, failed.Status);
            Assert.Equal("http_503", Tags(failed)["error.type"]);
            Assert.False(Tags(failed).ContainsKey("kyp.source"));

            // Render errors.
            Assert.Throws<MissingVariableException>(() => c.Render("greeting", new Dictionary<string, string> { ["name"] = "x" }));
            Assert.Throws<PromptNotFoundException>(() => c.RenderWithMeta("nope", null));

            var m = t.Collect();
            Assert.Equal(new Dictionary<string, long> { ["http_503/cdn"] = 2, ["blob_unavailable/cdn"] = 1, ["http_503/origin"] = 1 }, Sums(m["kyp.fallbacks"], "error.type", "kyp.source"));
            Assert.Equal(new Dictionary<string, long> { ["cdn"] = 1 }, Sums(m["kyp.hash_mismatches"], "kyp.source"));
            Assert.Equal(new Dictionary<string, long> { ["missing_variable/greeting"] = 1, ["not_found/nope"] = 1 }, Sums(m["kyp.render.errors"], "error.type", "kyp.prompt.name"));
            long rounds = 0;
            foreach (ref readonly var p in m["kyp.refresh.duration"].GetMetricPoints()) rounds += p.GetHistogramCount();
            Assert.Equal(4, rounds);
            foreach (ref readonly var p in m["kyp.revision"].GetMetricPoints()) Assert.Equal(13, p.GetGaugeLastValueLong());
            foreach (ref readonly var p in m["kyp.staleness"].GetMetricPoints()) Assert.True(p.GetGaugeLastValueDouble() >= 0);
        }

        [Fact]
        public async Task UneventfulRoundsAreNotTracedByDefault()
        {
            foreach (bool all in new[] { false, true })
            {
                using var t = new Tel();
                using var tmp = new TempDir();
                Deploy("v12", tmp.Sub("cdn"));
                using var s = FakeCdn.Start("listener", new Dictionary<string, (string, string)> { ["cdn"] = ("/v1/d/" + Key, tmp.Sub("cdn")) });
                var o = Quiet();
                o.DeliveryKey = Key;
                o.CdnBase = s.Base + "/v1/d";
                o.OriginBase = s.Base + "/v1/delivery";
                o.PollInterval = TimeSpan.FromHours(1);
                await using var c = await KeepYourPromptsClient.CreateAsync(o);
                using var ins = c.AddOpenTelemetry(new KeepYourPromptsInstrumentationOptions { TraceAllRefreshes = all });
                Assert.True(await c.RefreshAsync());
                Assert.Equal(all ? 1 : 0, t.Named("kyp.refresh").Count);
            }
        }

        private sealed class Throwing : IKypObserver
        {
            public void OnRefresh(RefreshRecord record) => throw new InvalidOperationException("boom");
            public void OnRenderError(RenderErrorRecord error) => throw new InvalidOperationException("boom");
        }

        [Fact]
        public async Task ThrowingObserverIsHarmless()
        {
            var o = Quiet();
            o.SnapshotDir = Fixture("v12");
            o.Observers.Add(new Throwing());
            await using var c = await KeepYourPromptsClient.CreateAsync(o);
            Assert.Throws<MissingVariableException>(() => c.Render("greeting", null));
            Assert.Contains("support agent", c.Get("triage"));
        }

        private static Dictionary<string, long> Sums(Metric m, params string[] keys)
        {
            var o = new Dictionary<string, long>();
            foreach (ref readonly var p in m.GetMetricPoints())
            {
                var tags = new Dictionary<string, object?>();
                foreach (var kv in p.Tags) tags[kv.Key] = kv.Value;
                string k = string.Join("/", keys.Select(x => tags.TryGetValue(x, out var v) ? v?.ToString() : ""));
                o[k] = (o.TryGetValue(k, out var n) ? n : 0) + p.GetSumLong();
            }
            return o;
        }
    }
}
