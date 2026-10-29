using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

namespace KeepYourPrompts
{
    /// <summary>A deployed prompt.</summary>
    public sealed class Prompt
    {
        internal Prompt(string name, long version, string sha256, IReadOnlyList<string> variables, string text)
        {
            Name = name;
            Version = version;
            Sha256 = sha256;
            Variables = variables;
            Text = text;
        }

        /// <summary>Prompt name; may contain <c>/</c> (e.g. <c>agents/reviewer</c>).</summary>
        public string Name { get; }

        /// <summary>Prompt version from the manifest.</summary>
        public long Version { get; }

        /// <summary>Lowercase hex SHA-256 of <see cref="Text"/>.</summary>
        public string Sha256 { get; }

        /// <summary>Declared variables (or those found in the text when the manifest lists none).</summary>
        public IReadOnlyList<string> Variables { get; }

        /// <summary>The raw template.</summary>
        public string Text { get; }

        /// <summary>Renders the template.</summary>
        public string Render(IReadOnlyDictionary<string, string>? vars, OnMissing onMissing = OnMissing.Error) =>
            Templates.Render(Text, vars, onMissing);

        /// <inheritdoc />
        public override string ToString() => Name + " v" + Version;
    }

    /// <summary>One copy of a workspace in the protocol layout (<c>envs/&lt;app&gt;/&lt;env&gt;.json</c>, <c>blobs/&lt;sha256&gt;</c>).</summary>
    public sealed class Mirror
    {
        /// <summary>Creates a mirror. Prefer the factory methods.</summary>
        public Mirror(string name, string url, string? bearerToken = null)
        {
            Name = name ?? throw new ArgumentNullException(nameof(name));
            Url = url ?? throw new ArgumentNullException(nameof(url));
            BearerToken = bearerToken ?? "";
        }

        /// <summary>Shown in <see cref="ClientStatus"/> and logs, e.g. <c>cdn</c>.</summary>
        public string Name { get; }

        /// <summary><c>https://host/base</c>, <c>file:///dir</c>, a plain path, or <c>embedded:</c>.</summary>
        public string Url { get; }

        /// <summary>Sent as <c>Authorization: Bearer</c> (git mirror, origin); empty for none.</summary>
        public string BearerToken { get; }

        internal Assembly? Assembly { get; private set; }
        internal string ResourcePrefix { get; private set; } = "";

        /// <summary>A folder written by <c>kyp pull</c>.</summary>
        public static Mirror File(string dir, string name = "snapshot") => new Mirror(name, dir);

        /// <summary>An HTTP(S) base URL.</summary>
        public static Mirror Http(string baseUrl, string name, string? bearerToken = null) => new Mirror(name, baseUrl, bearerToken);

        /// <summary>
        /// A snapshot embedded in <paramref name="assembly"/> as resources named <c>&lt;prefix&gt;/envs/...</c> and
        /// <c>&lt;prefix&gt;/blobs/...</c> (see the README for the csproj item).
        /// </summary>
        public static Mirror Embedded(Assembly assembly, string prefix = "kyp") =>
            new Mirror("embedded", "embedded:" + prefix) { Assembly = assembly ?? throw new ArgumentNullException(nameof(assembly)), ResourcePrefix = prefix.Trim('/') };

        /// <inheritdoc />
        public override string ToString() => Name + " " + Url + (BearerToken.Length > 0 ? " (bearer ***)" : "");
    }

    /// <summary>Health of one mirror, part of <see cref="ClientStatus"/>.</summary>
    public sealed class MirrorStatus
    {
        internal MirrorStatus(string name, string url, int consecutiveFailures, string lastError, DateTimeOffset? lastSuccess)
        {
            Name = name;
            Url = url;
            ConsecutiveFailures = consecutiveFailures;
            LastError = lastError;
            LastSuccess = lastSuccess;
        }

        /// <summary>e.g. <c>cdn</c>.</summary>
        public string Name { get; }
        /// <summary>Base URL with the delivery key shortened.</summary>
        public string Url { get; }
        /// <summary>Failures since the last success.</summary>
        public int ConsecutiveFailures { get; }
        /// <summary>Latest error; empty when healthy.</summary>
        public string LastError { get; }
        /// <summary>Last time it answered.</summary>
        public DateTimeOffset? LastSuccess { get; }
    }

    /// <summary>Client health, for logs, metrics and readiness probes.</summary>
    public sealed class ClientStatus
    {
        internal ClientStatus(bool ready, string source, long revision, string workspace, string deployedAt, int promptCount,
            DateTimeOffset? lastSuccess, string lastError, TimeSpan staleFor, IReadOnlyList<MirrorStatus> mirrors)
        {
            Ready = ready;
            Source = source;
            Revision = revision;
            Workspace = workspace;
            DeployedAt = deployedAt;
            PromptCount = promptCount;
            LastSuccess = lastSuccess;
            LastError = lastError;
            StaleFor = staleFor;
            Mirrors = mirrors;
        }

        /// <summary>A manifest is loaded.</summary>
        public bool Ready { get; }
        /// <summary>Mirror that served or last confirmed the current state: <c>embedded</c>, <c>snapshot</c>, <c>disk-cache</c>, <c>cdn</c>, <c>origin</c>, <c>git</c>.</summary>
        public string Source { get; }
        /// <summary>Manifest revision; 0 when nothing is loaded.</summary>
        public long Revision { get; }
        /// <summary>Workspace slug from the manifest.</summary>
        public string Workspace { get; }
        /// <summary><c>deployed_at</c> from the manifest.</summary>
        public string DeployedAt { get; }
        /// <summary>Number of prompts.</summary>
        public int PromptCount { get; }
        /// <summary>Last time a polled mirror confirmed the manifest (200 or 304).</summary>
        public DateTimeOffset? LastSuccess { get; }
        /// <summary>Failures in the latest round, e.g. <c>cdn: HTTP 503</c>; empty when the first mirror answered.</summary>
        public string LastError { get; }
        /// <summary>Time since <see cref="LastSuccess"/> (since start-up if never). Alert on this.</summary>
        public TimeSpan StaleFor { get; }
        /// <summary>Per-mirror health.</summary>
        public IReadOnlyList<MirrorStatus> Mirrors { get; }
    }

    /// <summary>Raised after a new revision was swapped in.</summary>
    public sealed class PromptsUpdatedEventArgs : EventArgs
    {
        internal PromptsUpdatedEventArgs(long oldRevision, long newRevision, string source, IReadOnlyList<string> changed)
        {
            OldRevision = oldRevision;
            NewRevision = newRevision;
            Source = source;
            Changed = changed.ToArray();
        }

        /// <summary>Revision held before; 0 if nothing was loaded.</summary>
        public long OldRevision { get; }
        /// <summary>Revision now served.</summary>
        public long NewRevision { get; }
        /// <summary>Mirror that delivered it.</summary>
        public string Source { get; }
        /// <summary>Prompts added, removed or with a new body.</summary>
        public IReadOnlyList<string> Changed { get; }
    }

    /// <summary>Log levels used by the SDK.</summary>
    public enum KypLogLevel
    {
        /// <summary>Debug.</summary>
        Debug,
        /// <summary>Info.</summary>
        Info,
        /// <summary>Warning.</summary>
        Warn,
        /// <summary>Error.</summary>
        Error,
        /// <summary>Nothing is logged.</summary>
        Off,
    }
}
