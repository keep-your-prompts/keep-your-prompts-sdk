using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Globalization;
using System.Linq;
using System.Text;

namespace KeepYourPrompts.OpenTelemetry
{
    /// <summary>Options for <see cref="KeepYourPromptsInstrumentation"/>.</summary>
    public sealed class KeepYourPromptsInstrumentationOptions
    {
        /// <summary>
        /// Record prompt templates and variable values on annotated activities. Default <c>false</c>, or
        /// <c>KYP_OTEL_CAPTURE_CONTENT=true</c>. PRIVACY: variable values often hold personal data; they reach every
        /// backend your traces go to.
        /// </summary>
        public bool? CaptureContent { get; set; }

        /// <summary>Also set <c>gen_ai.prompt.name</c> / <c>gen_ai.prompt.version</c> (default <c>true</c>).</summary>
        public bool GenAiAttributes { get; set; } = true;

        /// <summary>Also set <c>prompt.vendor</c>, <c>prompt.id</c>, <c>llm.prompt_template.version</c> (default <c>false</c>).</summary>
        public bool OpenInference { get; set; }

        /// <summary>Also export activities for uneventful <c>not_modified</c> rounds (default <c>false</c>).</summary>
        public bool TraceAllRefreshes { get; set; }
    }

    /// <summary>
    /// Records <c>kyp.refresh</c> activities and <c>kyp.*</c> metrics for a client (it is an
    /// <see cref="IKypObserver"/>) and annotates your LLM activities (protocol/tracing.md). Enable the source and
    /// meter with <c>AddKeepYourPromptsInstrumentation()</c> on your tracer and meter provider builders.
    /// </summary>
    public sealed class KeepYourPromptsInstrumentation : IKypObserver, IDisposable
    {
        /// <summary>ActivitySource and Meter name, the same in every SDK.</summary>
        public const string ScopeName = "keepyourprompts";

        /// <summary>Histogram buckets of <c>kyp.refresh.duration</c>, in seconds.</summary>
        public static readonly IReadOnlyList<double> RefreshBuckets = new[] { 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 };

        internal static readonly ActivitySource Source = new ActivitySource(ScopeName, KeepYourPromptsClient.Version);

        private readonly bool _capture;
        private readonly bool _genAi;
        private readonly bool _openInference;
        private readonly bool _traceAll;
        private readonly Meter _meter;
        private readonly Histogram<double> _duration;
        private readonly Counter<long> _fallbacks;
        private readonly Counter<long> _mismatches;
        private readonly Counter<long> _renderErrors;
        private volatile KeepYourPromptsClient? _client;
        private IDisposable? _subscription;
        private volatile bool _active = true;

        /// <summary>
        /// Creates the instruments without a client: add it to <see cref="KeepYourPromptsOptions.Observers"/> so the
        /// start-up round is recorded, then call <see cref="Attach"/>. Or use <see cref="Instrument"/>.
        /// </summary>
        public KeepYourPromptsInstrumentation(KeepYourPromptsInstrumentationOptions? options = null)
        {
            options ??= new KeepYourPromptsInstrumentationOptions();
            _capture = options.CaptureContent ?? EnvCapture();
            _genAi = options.GenAiAttributes;
            _openInference = options.OpenInference;
            _traceAll = options.TraceAllRefreshes;
            _meter = new Meter(ScopeName, KeepYourPromptsClient.Version);
            _duration = _meter.CreateHistogram<double>("kyp.refresh.duration", "s", "Wall time of each prompt refresh round.",
                tags: null, advice: new InstrumentAdvice<double> { HistogramBucketBoundaries = RefreshBuckets });
            _fallbacks = _meter.CreateCounter<long>("kyp.fallbacks", "{fallback}", "Mirror failures that made a refresh move on to the next mirror.");
            _mismatches = _meter.CreateCounter<long>("kyp.hash_mismatches", "{blob}", "Prompt bodies discarded because their SHA-256 did not match.");
            _renderErrors = _meter.CreateCounter<long>("kyp.render.errors", "{error}", "Render failures: unknown prompt or missing variable.");
            _meter.CreateObservableGauge("kyp.staleness", ObserveStaleness, "s", "Seconds since a mirror last confirmed the prompts held.");
            _meter.CreateObservableGauge("kyp.revision", ObserveRevision, "{revision}", "Manifest revision held (0 when nothing is loaded).");
        }

        /// <summary>Creates an instrumentation, subscribes it to <paramref name="client"/> and attaches it.</summary>
        public static KeepYourPromptsInstrumentation Instrument(KeepYourPromptsClient client, KeepYourPromptsInstrumentationOptions? options = null)
        {
            var i = new KeepYourPromptsInstrumentation(options);
            i.Attach(client);
            i._subscription = client.AddObserver(i);
            return i;
        }

        /// <summary>Sets the client used by <c>Annotate(name)</c> and the gauges. Does not subscribe (see <see cref="Instrument"/>).</summary>
        public KeepYourPromptsInstrumentation Attach(KeepYourPromptsClient client)
        {
            _client = client ?? throw new ArgumentNullException(nameof(client));
            return this;
        }

        /// <summary>Stops recording: unsubscribes and disposes the meter.</summary>
        public void Dispose()
        {
            _active = false;
            _subscription?.Dispose();
            _subscription = null;
            _meter.Dispose();
        }

        private static bool EnvCapture()
        {
            var v = (Environment.GetEnvironmentVariable("KYP_OTEL_CAPTURE_CONTENT") ?? "").Trim().ToLowerInvariant();
            return v == "1" || v == "true" || v == "yes" || v == "on";
        }

        private static KeyValuePair<string, object?> Tag(string k, object? v) => new KeyValuePair<string, object?>(k, v);

        private IEnumerable<Measurement<double>> ObserveStaleness()
        {
            var c = _client;
            if (c == null || !_active) return Array.Empty<Measurement<double>>();
            return new[] { new Measurement<double>(c.Status.StaleFor.TotalSeconds, Tag("kyp.app", c.App), Tag("kyp.env", c.Env)) };
        }

        private IEnumerable<Measurement<long>> ObserveRevision()
        {
            var c = _client;
            if (c == null || !_active) return Array.Empty<Measurement<long>>();
            return new[] { new Measurement<long>(c.Revision, Tag("kyp.app", c.App), Tag("kyp.env", c.Env)) };
        }

        // --- IKypObserver ---------------------------------------------------------------------------

        /// <inheritdoc />
        public void OnRenderError(RenderErrorRecord e)
        {
            if (!_active) return;
            _renderErrors.Add(1, Tag("kyp.app", e.App), Tag("kyp.env", e.Env), Tag("kyp.prompt.name", e.Name), Tag("error.type", e.ErrorType));
        }

        /// <inheritdoc />
        public void OnRefresh(RefreshRecord rec)
        {
            if (!_active) return;
            try
            {
                Record(rec);
            }
            catch (Exception)
            {
                // telemetry never breaks the client
            }
        }

        private void Record(RefreshRecord rec)
        {
            var m = new TagList { { "kyp.app", rec.App }, { "kyp.env", rec.Env }, { "kyp.refresh.trigger", rec.Trigger }, { "kyp.refresh.result", rec.Result } };
            if (rec.Source.Length > 0) m.Add("kyp.source", rec.Source);
            _duration.Record(rec.Duration.TotalSeconds, m);
            foreach (var e in rec.Events)
            {
                var a = e.Attributes;
                if (e.Name == "kyp.fallback")
                    _fallbacks.Add(1, new TagList { { "kyp.app", rec.App }, { "kyp.env", rec.Env }, { "kyp.source", a["kyp.source"] }, { "kyp.mirror", a["kyp.mirror"] }, { "error.type", a["error.type"] } });
                else if (e.Name == "kyp.hash_mismatch")
                    _mismatches.Add(1, new TagList { { "kyp.app", rec.App }, { "kyp.env", rec.Env }, { "kyp.source", a["kyp.source"] }, { "kyp.mirror", a["kyp.mirror"] } });
            }
            if (rec.Result == "not_modified" && rec.Events.Count == 0 && !_traceAll) return;

            var tags = new List<KeyValuePair<string, object?>>
            {
                Tag("kyp.app", rec.App), Tag("kyp.env", rec.Env), Tag("kyp.refresh.trigger", rec.Trigger), Tag("kyp.refresh.result", rec.Result),
            };
            if (rec.Revision != 0) tags.Add(Tag("kyp.revision", rec.Revision));
            if (rec.Workspace.Length > 0) tags.Add(Tag("kyp.workspace", rec.Workspace));
            if (rec.Source.Length > 0)
            {
                tags.Add(Tag("kyp.source", rec.Source));
                tags.Add(Tag("kyp.mirror", rec.Mirror));
            }
            bool failed = rec.Result == "failed";
            if (failed) tags.Add(Tag("error.type", rec.ErrorType.Length > 0 ? rec.ErrorType : "_OTHER"));

            // Background and start-up rounds are root activities; a manual refresh joins the caller's trace.
            var saved = Activity.Current;
            if (rec.Trigger != "manual") Activity.Current = null;
            try
            {
                using var activity = Source.StartActivity("kyp.refresh", ActivityKind.Internal, default(ActivityContext), tags, null, rec.Start);
                if (activity == null) return;
                foreach (var e in rec.Events)
                    activity.AddEvent(new ActivityEvent(e.Name, e.Time, new ActivityTagsCollection(e.Attributes.Select(kv => Tag(kv.Key, kv.Value)))));
                if (failed) activity.SetStatus(ActivityStatusCode.Error, rec.Error.Length > 500 ? rec.Error.Substring(0, 500) : rec.Error);
                activity.SetEndTime((rec.Start + rec.Duration).UtcDateTime);
            }
            finally
            {
                Activity.Current = saved;
            }
        }

        // --- annotate -------------------------------------------------------------------------------

        /// <summary>
        /// Sets <c>kyp.*</c> and <c>gen_ai.prompt.*</c> for the body of <paramref name="name"/> held now on
        /// <paramref name="activity"/> (default <see cref="Activity.Current"/>). Throws
        /// <see cref="PromptNotFoundException"/>, never for telemetry reasons.
        /// </summary>
        public PromptMeta Annotate(string name, Activity? activity = null, IReadOnlyDictionary<string, string>? variables = null)
        {
            var c = _client ?? throw new InvalidOperationException("kyp: Annotate(name) needs a client: use Instrument or Attach");
            return Annotate(c.Meta(name), activity, variables);
        }

        /// <summary>Annotates with the body a <c>RenderWithMeta</c> call used.</summary>
        public PromptMeta Annotate(Rendered rendered, Activity? activity = null, IReadOnlyDictionary<string, string>? variables = null) =>
            Annotate(rendered.Meta, activity, variables);

        /// <summary>Annotates <paramref name="activity"/> (default <see cref="Activity.Current"/>) with <paramref name="meta"/>.</summary>
        public PromptMeta Annotate(PromptMeta meta, Activity? activity = null, IReadOnlyDictionary<string, string>? variables = null)
        {
            string? template = null;
            var c = _client;
            if (_capture && c != null && c.Contains(meta.Name))
            {
                try
                {
                    var p = c.Prompt(meta.Name);
                    if (p.Sha256 == meta.Sha256) template = p.Text; // only that very body
                }
                catch (KypException)
                {
                    // swapped meanwhile
                }
            }
            (activity ?? Activity.Current)?.SetPromptAttributes(meta, variables, template, _capture, _genAi, _openInference);
            return meta;
        }
    }

    /// <summary>Annotating activities without an instrumentation instance.</summary>
    public static class KypActivityExtensions
    {
        /// <summary>
        /// Sets <c>kyp.*</c> (and by default <c>gen_ai.prompt.*</c>) from <paramref name="meta"/>. With
        /// <paramref name="captureContent"/>, also <c>kyp.prompt.template</c> (when given) and
        /// <c>gen_ai.prompt.variable.&lt;name&gt;</c>. Never throws.
        /// </summary>
        public static Activity SetPromptAttributes(this Activity activity, PromptMeta meta, IReadOnlyDictionary<string, string>? variables = null,
            string? template = null, bool captureContent = false, bool genAiAttributes = true, bool openInference = false)
        {
            try
            {
                if (!activity.IsAllDataRequested) return activity;
                foreach (var kv in genAiAttributes ? meta.Attributes() : meta.KypAttributes()) activity.SetTag(kv.Key, kv.Value);
                if (openInference)
                {
                    activity.SetTag("prompt.vendor", "keepyourprompts");
                    activity.SetTag("prompt.id", meta.App + "/" + meta.Env + "/" + meta.Name);
                    activity.SetTag("llm.prompt_template.version", meta.Version.ToString(CultureInfo.InvariantCulture));
                }
                if (captureContent)
                {
                    if (template != null)
                    {
                        activity.SetTag("kyp.prompt.template", template);
                        if (openInference) activity.SetTag("llm.prompt_template.template", template);
                    }
                    if (variables != null && variables.Count > 0)
                    {
                        foreach (var kv in variables) activity.SetTag("gen_ai.prompt.variable." + kv.Key, kv.Value);
                        if (openInference) activity.SetTag("llm.prompt_template.variables", ToJson(variables));
                    }
                }
            }
            catch (Exception)
            {
                // telemetry never breaks the app
            }
            return activity;
        }

        private static string ToJson(IReadOnlyDictionary<string, string> m)
        {
            var sb = new StringBuilder("{");
            bool first = true;
            foreach (var kv in m)
            {
                if (!first) sb.Append(',');
                first = false;
                Quote(sb, kv.Key);
                sb.Append(':');
                Quote(sb, kv.Value);
            }
            return sb.Append('}').ToString();
        }

        private static void Quote(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char ch in s)
            {
                switch (ch)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(ch);
                        break;
                }
            }
            sb.Append('"');
        }
    }
}
