// Keep Your Prompts for Semantic Kernel. This code is under the repository's LICENSE.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Microsoft.SemanticKernel;

namespace KeepYourPrompts.SemanticKernel
{
    /// <summary>Options for functions created from deployed prompts.</summary>
    public sealed class KypFunctionOptions
    {
        /// <summary>Function name; default: the prompt name with every character outside <c>[A-Za-z0-9_]</c> replaced by <c>_</c>.</summary>
        public string? FunctionName { get; set; }

        /// <summary>Function description (what the model sees when the function is a tool).</summary>
        public string? Description { get; set; }

        /// <summary>Execution settings, e.g. model and temperature.</summary>
        public PromptExecutionSettings? ExecutionSettings { get; set; }

        /// <summary>Insert argument values without HTML-encoding them (only for trusted values).</summary>
        public bool AllowDangerouslySetContent { get; set; }

        /// <summary>What a missing variable does; default <see cref="OnMissing.Error"/>.</summary>
        public OnMissing OnMissing { get; set; } = OnMissing.Error;

        /// <summary>Logger factory passed to Semantic Kernel.</summary>
        public ILoggerFactory? LoggerFactory { get; set; }
    }

    /// <summary>Kernel functions and plugins from deployed prompts.</summary>
    public static class KypKernelExtensions
    {
        /// <summary>
        /// A <see cref="KernelFunction"/> that renders the deployed prompt <paramref name="promptName"/> on every
        /// invocation (memory only), so a deploy applies to the next call without rebuilding the kernel.
        /// </summary>
        public static KernelFunction CreateFunctionFromDeployedPrompt(this KeepYourPromptsClient client, string promptName, KypFunctionOptions? options = null)
        {
            if (client == null) throw new ArgumentNullException(nameof(client));
            options ??= new KypFunctionOptions();
            Prompt p = client.Prompt(promptName);
            var config = new PromptTemplateConfig(p.Text)
            {
                Name = options.FunctionName ?? FunctionName(promptName),
                Description = options.Description,
                TemplateFormat = KypPromptTemplateFactory.TemplateFormat,
                AllowDangerouslySetContent = options.AllowDangerouslySetContent,
            };
            foreach (string v in p.Variables)
            {
                config.InputVariables.Add(new InputVariable { Name = v, IsRequired = options.OnMissing == OnMissing.Error });
            }
            if (options.ExecutionSettings != null) config.AddExecutionSettings(options.ExecutionSettings);
            var template = new KypPromptTemplate(client, promptName, config, options.OnMissing);
            return KernelFunctionFactory.CreateFromPrompt(template, config, options.LoggerFactory);
        }

        /// <summary><see cref="CreateFunctionFromDeployedPrompt(KeepYourPromptsClient, string, KypFunctionOptions)"/> with the kernel's logger factory.</summary>
        public static KernelFunction CreateFunctionFromDeployedPrompt(this Kernel kernel, KeepYourPromptsClient client, string promptName, KypFunctionOptions? options = null)
        {
            if (kernel == null) throw new ArgumentNullException(nameof(kernel));
            options ??= new KypFunctionOptions();
            options.LoggerFactory ??= kernel.LoggerFactory;
            return client.CreateFunctionFromDeployedPrompt(promptName, options);
        }

        /// <summary>
        /// A plugin with one function per deployed prompt whose name starts with <paramref name="prefix"/>
        /// (<c>support/triage</c> with prefix <c>support/</c> becomes function <c>triage</c>).
        /// </summary>
        public static KernelPlugin CreatePluginFromDeployedPrompts(this KeepYourPromptsClient client, string pluginName, string prefix = "", Func<string, KypFunctionOptions?>? options = null)
        {
            if (client == null) throw new ArgumentNullException(nameof(client));
            var functions = new List<KernelFunction>();
            foreach (string name in client.Names.Where(n => n.StartsWith(prefix, StringComparison.Ordinal) && n.Length > prefix.Length))
            {
                KypFunctionOptions o = options?.Invoke(name) ?? new KypFunctionOptions();
                o.FunctionName ??= FunctionName(name.Substring(prefix.Length));
                functions.Add(client.CreateFunctionFromDeployedPrompt(name, o));
            }
            return KernelPluginFactory.CreateFromFunctions(pluginName, functions);
        }

        /// <summary>Adds <see cref="KypPromptMetadataFilter"/> to the kernel (once).</summary>
        public static Kernel AddKypPromptMetadata(this Kernel kernel)
        {
            if (kernel == null) throw new ArgumentNullException(nameof(kernel));
            if (!kernel.FunctionInvocationFilters.OfType<KypPromptMetadataFilter>().Any())
            {
                kernel.FunctionInvocationFilters.Add(new KypPromptMetadataFilter());
            }
            return kernel;
        }

        /// <summary>A valid Semantic Kernel function name from a prompt name.</summary>
        public static string FunctionName(string promptName)
        {
            var sb = new StringBuilder(promptName.Length);
            foreach (char c in promptName)
            {
                sb.Append((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' ? c : '_');
            }
            return sb.Length == 0 ? "prompt" : sb.ToString();
        }
    }

    /// <summary>
    /// Adds <c>kyp.prompt.name</c>, <c>kyp.prompt.version</c> and <c>kyp.prompt.sha256</c> of the version a
    /// deployed-prompt function rendered to its <see cref="FunctionResult.Metadata"/> (non-streaming invocations).
    /// </summary>
    public sealed class KypPromptMetadataFilter : IFunctionInvocationFilter
    {
        /// <inheritdoc />
        public async Task OnFunctionInvocationAsync(FunctionInvocationContext context, Func<FunctionInvocationContext, Task> next)
        {
            await next(context).ConfigureAwait(false);
            if (context.IsStreaming || !KypPromptTemplate.Rendered.TryGetValue(context.Arguments, out KypPromptMetadata? meta)) return;
            FunctionResult r = context.Result;
            var metadata = new Dictionary<string, object?>();
            if (r.Metadata != null)
            {
                foreach (KeyValuePair<string, object?> kv in r.Metadata) metadata[kv.Key] = kv.Value;
            }
            foreach (KeyValuePair<string, object?> kv in meta.ToDictionary()) metadata[kv.Key] = kv.Value;
            context.Result = new FunctionResult(r.Function, r.GetValue<object>(), r.Culture, metadata);
        }
    }
}
