// Keep Your Prompts for Semantic Kernel. This code is under the repository's LICENSE.
using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Net;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.SemanticKernel;

namespace KeepYourPrompts.SemanticKernel
{
    /// <summary>Which deployed prompt a render used: name, version and SHA-256 of the body.</summary>
    public sealed class KypPromptMetadata
    {
        /// <summary>Metadata and attribute keys.</summary>
        public const string NameKey = "kyp.prompt.name", VersionKey = "kyp.prompt.version", Sha256Key = "kyp.prompt.sha256";

        /// <summary>Creates the metadata.</summary>
        public KypPromptMetadata(string name, long version, string sha256)
        {
            Name = name;
            Version = version;
            Sha256 = sha256;
        }

        /// <summary>Prompt name.</summary>
        public string Name { get; }

        /// <summary>Prompt version from the manifest.</summary>
        public long Version { get; }

        /// <summary>Lowercase hex SHA-256 of the body.</summary>
        public string Sha256 { get; }

        /// <summary>From a core SDK prompt.</summary>
        public static KypPromptMetadata From(Prompt p) => new KypPromptMetadata(p.Name, p.Version, p.Sha256);

        /// <summary><c>kyp.prompt.name</c>, <c>kyp.prompt.version</c>, <c>kyp.prompt.sha256</c>.</summary>
        public IReadOnlyDictionary<string, object?> ToDictionary() =>
            new Dictionary<string, object?> { [NameKey] = Name, [VersionKey] = Version, [Sha256Key] = Sha256 };

        /// <inheritdoc />
        public override string ToString() => Name + " v" + Version;
    }

    /// <summary>
    /// An <see cref="IPromptTemplate"/> for Keep Your Prompts templates (<c>{{name}}</c> variables, <c>{{{{</c> for a
    /// literal <c>{{</c>), rendered by the core SDK. It either holds a fixed template text, or a client and a prompt
    /// name, in which case every render uses the version deployed at that moment (memory only, no I/O).
    /// </summary>
    /// <remarks>
    /// Like Semantic Kernel's own template engines, argument values are HTML-encoded unless the config or the input
    /// variable sets <c>AllowDangerouslySetContent</c>, so a value cannot inject <c>&lt;message&gt;</c> tags into a
    /// chat prompt. With it set, output is byte-for-byte what <c>KeepYourPromptsClient.Render</c> returns.
    /// </remarks>
    public sealed class KypPromptTemplate : IPromptTemplate
    {
        // The metadata of the render done for one KernelArguments instance (one invocation), read by
        // KypPromptMetadataFilter after the function ran.
        internal static readonly ConditionalWeakTable<KernelArguments, KypPromptMetadata> Rendered =
            new ConditionalWeakTable<KernelArguments, KypPromptMetadata>();

        private readonly PromptTemplateConfig _config;
        private readonly string? _text;
        private readonly KeepYourPromptsClient? _client;
        private readonly string? _promptName;
        private readonly OnMissing _onMissing;
        private KypPromptMetadata? _last;

        /// <summary>A template over fixed text (<see cref="PromptTemplateConfig.Template"/>).</summary>
        public KypPromptTemplate(PromptTemplateConfig config, OnMissing onMissing = OnMissing.Error)
        {
            _config = config ?? throw new ArgumentNullException(nameof(config));
            _text = config.Template ?? "";
            _onMissing = onMissing;
        }

        /// <summary>A live template: renders the deployed prompt <paramref name="promptName"/> on every call.</summary>
        public KypPromptTemplate(KeepYourPromptsClient client, string promptName, PromptTemplateConfig? config = null, OnMissing onMissing = OnMissing.Error)
        {
            _client = client ?? throw new ArgumentNullException(nameof(client));
            _promptName = promptName ?? throw new ArgumentNullException(nameof(promptName));
            _config = config ?? new PromptTemplateConfig(client.Get(promptName)) { TemplateFormat = KypPromptTemplateFactory.TemplateFormat };
            _onMissing = onMissing;
        }

        /// <summary>The deployed prompt this template follows, or null for a fixed text.</summary>
        public string? PromptName => _promptName;

        /// <summary>Metadata of the most recent render of a live template (null before the first one).</summary>
        public KypPromptMetadata? LastRendered => _last;

        /// <inheritdoc />
        public Task<string> RenderAsync(Kernel kernel, KernelArguments? arguments = null, CancellationToken cancellationToken = default)
        {
            string text;
            KypPromptMetadata? meta = null;
            if (_client != null)
            {
                Prompt p = _client.Prompt(_promptName!);
                text = p.Text;
                meta = KypPromptMetadata.From(p);
            }
            else
            {
                text = _text!;
            }

            var vars = new Dictionary<string, string>(StringComparer.Ordinal);
            // Defaults declared in the config, then the arguments.
            foreach (InputVariable iv in _config.InputVariables)
            {
                if (iv.Default != null) vars[iv.Name] = Encode(iv.Name, ToText(iv.Default));
            }
            if (arguments != null)
            {
                foreach (KeyValuePair<string, object?> kv in arguments)
                {
                    if (kv.Value != null) vars[kv.Key] = Encode(kv.Key, ToText(kv.Value));
                }
            }
            string rendered = Templates.Render(text, vars, _onMissing);
            if (meta != null)
            {
                _last = meta;
                if (arguments != null)
                {
                    Rendered.Remove(arguments);
                    Rendered.Add(arguments, meta);
                }
            }
            return Task.FromResult(rendered);
        }

        private static string ToText(object value) =>
            value as string ?? Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";

        private string Encode(string name, string value)
        {
            if (_config.AllowDangerouslySetContent) return value;
            foreach (InputVariable iv in _config.InputVariables)
            {
                if (iv.Name == name && iv.AllowDangerouslySetContent) return value;
            }
            return WebUtility.HtmlEncode(value);
        }
    }

    /// <summary>
    /// An <see cref="IPromptTemplateFactory"/> for <c>template_format: kyp</c>. Combine it with others through
    /// <see cref="AggregatorPromptTemplateFactory"/>.
    /// </summary>
    public sealed class KypPromptTemplateFactory : IPromptTemplateFactory
    {
        /// <summary>The template format name: <c>kyp</c>.</summary>
        public const string TemplateFormat = "kyp";

        private readonly OnMissing _onMissing;

        /// <summary>Strict by default: a missing variable throws <see cref="MissingVariableException"/>.</summary>
        public KypPromptTemplateFactory(OnMissing onMissing = OnMissing.Error)
        {
            _onMissing = onMissing;
        }

        /// <inheritdoc />
        public bool TryCreate(PromptTemplateConfig templateConfig, [NotNullWhen(true)] out IPromptTemplate? result)
        {
            if (templateConfig == null) throw new ArgumentNullException(nameof(templateConfig));
            if (string.Equals(templateConfig.TemplateFormat, TemplateFormat, StringComparison.Ordinal))
            {
                result = new KypPromptTemplate(templateConfig, _onMissing);
                return true;
            }
            result = null;
            return false;
        }
    }
}

#if NETSTANDARD2_0
namespace System.Diagnostics.CodeAnalysis
{
    [AttributeUsage(AttributeTargets.Parameter, Inherited = false)]
    internal sealed class NotNullWhenAttribute : Attribute
    {
        public NotNullWhenAttribute(bool returnValue) => ReturnValue = returnValue;

        public bool ReturnValue { get; }
    }
}
#endif
