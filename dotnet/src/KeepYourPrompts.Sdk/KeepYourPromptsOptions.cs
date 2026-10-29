using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Http;
using System.Reflection;

namespace KeepYourPrompts
{
    /// <summary>Client configuration. Only <see cref="App"/> is required (<see cref="Env"/> defaults to <c>prod</c>).</summary>
    public sealed class KeepYourPromptsOptions
    {
        /// <summary>Default CDN base.</summary>
        public const string DefaultCdnBase = "https://cdn.keepyourprompts.com/v1/d";
        /// <summary>Default origin base.</summary>
        public const string DefaultOriginBase = "https://api.keepyourprompts.com/v1/delivery";

        /// <summary>App slug, <c>[a-z0-9][a-z0-9-]{0,62}</c>. <c>KYP_APP</c>.</summary>
        public string App { get; set; } = "";
        /// <summary>Environment slug. <c>KYP_ENV</c>, default <c>prod</c>.</summary>
        public string Env { get; set; } = "prod";
        /// <summary>Read-only delivery key (<c>kypd_...</c>); enables the CDN and origin mirrors. <c>KYP_DELIVERY_KEY</c>.</summary>
        public string? DeliveryKey { get; set; }
        /// <summary>Optional: lets the disk cache be found without scanning <see cref="CacheDir"/>. <c>KYP_WORKSPACE</c>.</summary>
        public string? Workspace { get; set; }
        /// <summary>A snapshot folder written by <c>kyp pull</c>. <c>KYP_SNAPSHOT_DIR</c>.</summary>
        public string? SnapshotDir { get; set; }
        /// <summary>Where verified states are written so a restart without network comes up on the last version seen. <c>KYP_CACHE_DIR</c>.</summary>
        public string? CacheDir { get; set; }
        /// <summary>Your git sync target, e.g. <c>https://raw.githubusercontent.com/acme/prompts/main/.kyp</c>. <c>KYP_GIT_MIRROR</c>.</summary>
        public string? GitMirror { get; set; }
        /// <summary>Read-only token for a private git mirror, sent as a bearer token. <c>KYP_GIT_TOKEN</c>.</summary>
        public string? GitToken { get; set; }
        /// <summary><c>KYP_CDN_URL</c>.</summary>
        public string CdnBase { get; set; } = DefaultCdnBase;
        /// <summary><c>KYP_ORIGIN_URL</c>.</summary>
        public string OriginBase { get; set; } = DefaultOriginBase;

        /// <summary>When set, replaces the snapshot/CDN/origin/git mirrors with this ordered list.</summary>
        public IList<Mirror>? Mirrors { get; set; }
        /// <summary>Mirrors appended after the defaults (or after <see cref="Mirrors"/>).</summary>
        public IList<Mirror> ExtraMirrors { get; } = new List<Mirror>();

        /// <summary>An embedded-resource snapshot, tried first. See <see cref="UseEmbeddedSnapshot"/>.</summary>
        public Mirror? EmbeddedSnapshot { get; set; }

        /// <summary>How often the manifest is revalidated (plus or minus 10% jitter). Default 30 s, minimum 100 ms. <c>KYP_POLL_INTERVAL</c> (seconds).</summary>
        public TimeSpan PollInterval { get; set; } = TimeSpan.FromSeconds(30);
        /// <summary>Default 2 s.</summary>
        public TimeSpan ConnectTimeout { get; set; } = TimeSpan.FromSeconds(2);
        /// <summary>Default 5 s.</summary>
        public TimeSpan RequestTimeout { get; set; } = TimeSpan.FromSeconds(5);
        /// <summary>How long creation waits on the network when nothing local exists. Default 3 s.</summary>
        public TimeSpan StartupTimeout { get; set; } = TimeSpan.FromSeconds(3);
        /// <summary>Cap on how long a failing mirror is skipped. Default 5 min.</summary>
        public TimeSpan MaxBackoff { get; set; } = TimeSpan.FromMinutes(5);
        /// <summary>Start with no prompts instead of throwing <see cref="UnavailableException"/>.</summary>
        public bool StartEmpty { get; set; }
        /// <summary>Default <c>kyp-dotnet/0.1.0</c>.</summary>
        public string UserAgent { get; set; } = "kyp-dotnet/" + KeepYourPromptsClient.Version;

        /// <summary>Log sink; default writes <c>[kyp] warn: ...</c> to stderr.</summary>
        public Action<KypLogLevel, string>? Logger { get; set; }
        /// <summary>Minimum level logged. Default <see cref="KypLogLevel.Warn"/>. <c>KYP_LOG</c>.</summary>
        public KypLogLevel LogLevel { get; set; } = KypLogLevel.Warn;

        /// <summary>Custom HTTP handler (proxies, tests). The client owns and disposes it.</summary>
        public Func<HttpMessageHandler>? HttpHandlerFactory { get; set; }

        /// <summary>Use a snapshot embedded in <paramref name="assembly"/> under resource prefix <paramref name="prefix"/>.</summary>
        public KeepYourPromptsOptions UseEmbeddedSnapshot(Assembly assembly, string prefix = "kyp")
        {
            EmbeddedSnapshot = Mirror.Embedded(assembly, prefix);
            return this;
        }

        /// <summary>Reads <c>KYP_*</c> environment variables.</summary>
        public static KeepYourPromptsOptions FromEnvironment() => FromEnvironment(Environment.GetEnvironmentVariable);

        /// <summary>Reads <c>KYP_*</c> variables through <paramref name="getenv"/>.</summary>
        public static KeepYourPromptsOptions FromEnvironment(Func<string, string?> getenv)
        {
            string G(string k) => (getenv(k) ?? "").Trim();
            string? N(string k) => G(k).Length == 0 ? null : G(k);
            var o = new KeepYourPromptsOptions
            {
                App = G("KYP_APP"),
                DeliveryKey = N("KYP_DELIVERY_KEY"),
                Workspace = N("KYP_WORKSPACE"),
                SnapshotDir = N("KYP_SNAPSHOT_DIR"),
                CacheDir = N("KYP_CACHE_DIR"),
                GitMirror = N("KYP_GIT_MIRROR"),
                GitToken = N("KYP_GIT_TOKEN"),
            };
            if (N("KYP_ENV") is string env) o.Env = env;
            if (N("KYP_CDN_URL") is string cdn) o.CdnBase = cdn;
            if (N("KYP_ORIGIN_URL") is string origin) o.OriginBase = origin;
            if (double.TryParse(G("KYP_POLL_INTERVAL"), NumberStyles.Float, CultureInfo.InvariantCulture, out var secs) && secs > 0)
                o.PollInterval = TimeSpan.FromMilliseconds(secs * 1000);
            switch (G("KYP_LOG"))
            {
                case "off": o.LogLevel = KypLogLevel.Off; break;
                case "debug": o.LogLevel = KypLogLevel.Debug; break;
                case "info": o.LogLevel = KypLogLevel.Info; break;
                case "error": o.LogLevel = KypLogLevel.Error; break;
            }
            return o;
        }
    }
}
