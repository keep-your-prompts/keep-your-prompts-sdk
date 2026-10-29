using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

namespace KeepYourPrompts
{
    /// <summary>
    /// Which deployed body a call used (protocol/tracing.md). Read from memory with
    /// <see cref="KeepYourPromptsClient.Meta"/> or <see cref="KeepYourPromptsClient.RenderWithMeta"/>.
    /// </summary>
    public sealed class PromptMeta : IEquatable<PromptMeta>
    {
        /// <summary>Creates prompt metadata (tests, or metadata carried across processes).</summary>
        public PromptMeta(string name, long version, string sha256, string app, string env, string workspace, long revision, string source)
        {
            Name = name ?? throw new ArgumentNullException(nameof(name));
            Version = version;
            Sha256 = sha256 ?? throw new ArgumentNullException(nameof(sha256));
            App = app ?? "";
            Env = env ?? "";
            Workspace = workspace ?? "";
            Revision = revision;
            Source = source ?? "";
        }

        /// <summary>Prompt name.</summary>
        public string Name { get; }
        /// <summary>Prompt version from the manifest.</summary>
        public long Version { get; }
        /// <summary>Lowercase hex SHA-256 of the body used.</summary>
        public string Sha256 { get; }
        /// <summary>App slug.</summary>
        public string App { get; }
        /// <summary>Environment slug.</summary>
        public string Env { get; }
        /// <summary>Workspace from the manifest.</summary>
        public string Workspace { get; }
        /// <summary>Manifest revision held.</summary>
        public long Revision { get; }
        /// <summary>Normalised mirror kind (embedded, snapshot, cache, cdn, origin, git, custom); empty before anything is loaded.</summary>
        public string Source { get; }

        /// <summary>The <c>kyp.*</c> span attributes (values are <see cref="string"/> or <see cref="long"/>).</summary>
        public IDictionary<string, object> KypAttributes()
        {
            var a = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                ["kyp.prompt.name"] = Name,
                ["kyp.prompt.version"] = Version,
                ["kyp.prompt.sha256"] = Sha256,
                ["kyp.app"] = App,
                ["kyp.env"] = Env,
                ["kyp.revision"] = Revision,
            };
            if (Workspace.Length > 0) a["kyp.workspace"] = Workspace;
            if (Source.Length > 0) a["kyp.source"] = Source;
            return a;
        }

        /// <summary><see cref="KypAttributes"/> plus <c>gen_ai.prompt.name</c> and <c>gen_ai.prompt.version</c> (a string).</summary>
        public IDictionary<string, object> Attributes()
        {
            var a = KypAttributes();
            a["gen_ai.prompt.name"] = Name;
            a["gen_ai.prompt.version"] = Version.ToString(CultureInfo.InvariantCulture);
            return a;
        }

        /// <summary>The <c>kyp.*</c> attributes with flat keys (<c>kyp_prompt_name</c>, ...), for free-form metadata.</summary>
        public IDictionary<string, object> TraceMetadata()
        {
            var o = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var kv in KypAttributes()) o[kv.Key.Replace('.', '_')] = kv.Value;
            return o;
        }

        /// <summary><see cref="TraceMetadata"/>, for Langfuse observation or trace metadata.</summary>
        public IDictionary<string, object> LangfuseMetadata() => TraceMetadata();

        /// <summary><see cref="TraceMetadata"/>, for LangSmith run metadata.</summary>
        public IDictionary<string, object> LangSmithMetadata() => TraceMetadata();

        /// <inheritdoc />
        public bool Equals(PromptMeta? o) =>
            o != null && o.Name == Name && o.Version == Version && o.Sha256 == Sha256 && o.App == App && o.Env == Env &&
            o.Workspace == Workspace && o.Revision == Revision && o.Source == Source;

        /// <inheritdoc />
        public override bool Equals(object? obj) => Equals(obj as PromptMeta);

        /// <inheritdoc />
        public override int GetHashCode() => Sha256.GetHashCode() ^ (int)Revision;

        /// <inheritdoc />
        public override string ToString() => Name + " v" + Version + " (" + Sha256.Substring(0, Math.Min(12, Sha256.Length)) + ")";
    }

    /// <summary>What <see cref="KeepYourPromptsClient.RenderWithMeta"/> returns.</summary>
    public sealed class Rendered
    {
        internal Rendered(string text, PromptMeta meta)
        {
            Text = text;
            Meta = meta;
        }

        /// <summary>The rendered prompt.</summary>
        public string Text { get; }
        /// <summary>Which deployed body it came from.</summary>
        public PromptMeta Meta { get; }

        /// <inheritdoc />
        public override string ToString() => Text;
    }

    /// <summary>A span event recorded during a refresh round: <c>kyp.fallback</c>, <c>kyp.hash_mismatch</c> or <c>kyp.update</c>.</summary>
    public sealed class KypTelemetryEvent
    {
        internal KypTelemetryEvent(string name, DateTimeOffset time, IReadOnlyDictionary<string, object> attributes)
        {
            Name = name;
            Time = time;
            Attributes = attributes;
        }

        /// <summary>Event name.</summary>
        public string Name { get; }
        /// <summary>When it happened.</summary>
        public DateTimeOffset Time { get; }
        /// <summary>Attributes (<see cref="string"/> or <see cref="long"/> values).</summary>
        public IReadOnlyDictionary<string, object> Attributes { get; }
    }

    /// <summary>One refresh round, passed to <see cref="IKypObserver.OnRefresh"/>.</summary>
    public sealed class RefreshRecord
    {
        internal RefreshRecord(string app, string env, string trigger, string result, DateTimeOffset start, TimeSpan duration,
            string mirror, string source, long revision, long previousRevision, string workspace, string error, string errorType,
            IReadOnlyList<KypTelemetryEvent> events)
        {
            App = app;
            Env = env;
            Trigger = trigger;
            Result = result;
            Start = start;
            Duration = duration;
            Mirror = mirror;
            Source = source;
            Revision = revision;
            PreviousRevision = previousRevision;
            Workspace = workspace;
            Error = error;
            ErrorType = errorType;
            Events = events;
        }

        /// <summary>App slug.</summary>
        public string App { get; }
        /// <summary>Environment slug.</summary>
        public string Env { get; }
        /// <summary><c>start</c>, <c>poll</c> or <c>manual</c>.</summary>
        public string Trigger { get; }
        /// <summary><c>updated</c>, <c>not_modified</c> or <c>failed</c>.</summary>
        public string Result { get; }
        /// <summary>When the round started.</summary>
        public DateTimeOffset Start { get; }
        /// <summary>How long it took.</summary>
        public TimeSpan Duration { get; }
        /// <summary>Configured name of the mirror that answered (empty when failed).</summary>
        public string Mirror { get; }
        /// <summary>Its normalised kind.</summary>
        public string Source { get; }
        /// <summary>Revision held after the round.</summary>
        public long Revision { get; }
        /// <summary>Revision held before the round.</summary>
        public long PreviousRevision { get; }
        /// <summary>Workspace held.</summary>
        public string Workspace { get; }
        /// <summary>When failed: short message, delivery key redacted.</summary>
        public string Error { get; }
        /// <summary>When failed: low-cardinality <c>error.type</c>.</summary>
        public string ErrorType { get; }
        /// <summary>Span events, in order.</summary>
        public IReadOnlyList<KypTelemetryEvent> Events { get; }
    }

    /// <summary>A failed render: <see cref="ErrorType"/> is <c>not_found</c> or <c>missing_variable</c>.</summary>
    public sealed class RenderErrorRecord
    {
        internal RenderErrorRecord(string app, string env, string name, string errorType)
        {
            App = app;
            Env = env;
            Name = name;
            ErrorType = errorType;
        }

        /// <summary>App slug.</summary>
        public string App { get; }
        /// <summary>Environment slug.</summary>
        public string Env { get; }
        /// <summary>Prompt name.</summary>
        public string Name { get; }
        /// <summary><c>not_found</c> or <c>missing_variable</c>.</summary>
        public string ErrorType { get; }
    }

    /// <summary>Receives delivery telemetry. Exceptions are caught and logged; they never break the client.</summary>
    public interface IKypObserver
    {
        /// <summary>After each refresh round.</summary>
        void OnRefresh(RefreshRecord record);

        /// <summary>When <c>Render</c> or <c>RenderWithMeta</c> fails.</summary>
        void OnRenderError(RenderErrorRecord error);
    }

    /// <summary>Helpers shared by the SDK and the OpenTelemetry package.</summary>
    public static class KypTelemetry
    {
        private static readonly Regex BlobUnavailable = new Regex(@"blob \S+ unavailable", RegexOptions.CultureInvariant);
        private static readonly Regex HttpNotFound = new Regex(@"http (404|410)\b", RegexOptions.CultureInvariant);
        private static readonly Regex Http = new Regex(@"http (\d{3})\b", RegexOptions.CultureInvariant);
        private static readonly Regex Network = new Regex(@"connect|connection|network|socket|host|refused|unreachable|eof", RegexOptions.CultureInvariant);

        /// <summary>Maps a failure message to a low-cardinality <c>error.type</c>.</summary>
        public static string ClassifyError(string? message)
        {
            string m = (message ?? "").ToLowerInvariant();
            if (BlobUnavailable.IsMatch(m)) return "blob_unavailable";
            if (m.Contains("sha256 verification") || m.Contains("hash mismatch")) return "hash_mismatch";
            if (m.Contains("stale manifest")) return "stale";
            if (m.Contains("bad manifest") || m.Contains("invalid manifest")) return "bad_manifest";
            if (HttpNotFound.IsMatch(m) || m.Contains("not found") || m.Contains("no such file") || m.Contains("could not find") || m == "empty") return "not_found";
            var h = Http.Match(m);
            if (h.Success) return "http_" + h.Groups[1].Value;
            if (m.Contains("timeout") || m.Contains("timed out") || m.Contains("deadline")) return "timeout";
            if (Network.IsMatch(m)) return "network";
            return "_OTHER";
        }

        /// <summary>Maps a mirror to its <c>kyp.source</c> value.</summary>
        public static string NormalizeSource(Mirror m)
        {
            switch (m.Name)
            {
                case "": return "";
                case "disk-cache": return "cache";
                case "embedded":
                case "snapshot":
                case "cache":
                case "cdn":
                case "origin":
                case "git":
                    return m.Name;
            }
            switch (Transport.KindOf(m.Url))
            {
                case MirrorKind.Embedded: return "embedded";
                case MirrorKind.File: return "snapshot";
                case MirrorKind.Cache: return "cache";
                default: return "custom";
            }
        }
    }
}
