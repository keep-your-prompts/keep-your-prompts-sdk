using System;
using System.Collections.Generic;
using System.Linq;

namespace KeepYourPrompts
{
    /// <summary>Base class of everything the SDK throws.</summary>
    public class KypException : Exception
    {
        /// <summary>Creates the exception.</summary>
        public KypException(string message) : base(message) { }

        /// <summary>Creates the exception with an inner exception.</summary>
        public KypException(string message, Exception inner) : base(message, inner) { }
    }

    /// <summary><c>Get</c>, <c>Prompt</c> or <c>Render</c> for a name that is not in the deployed manifest.</summary>
    public sealed class PromptNotFoundException : KypException
    {
        /// <summary>Creates the exception.</summary>
        public PromptNotFoundException(string name, string? detail = null)
            : base("prompt not found: \"" + name + "\"" + (string.IsNullOrEmpty(detail) ? "" : " (" + detail + ")"))
        {
            Name = name;
        }

        /// <summary>The prompt name that was asked for.</summary>
        public string Name { get; }
    }

    /// <summary><c>Render</c> was called without a value for one or more <c>{{variables}}</c>.</summary>
    public sealed class MissingVariableException : KypException
    {
        /// <summary>Creates the exception.</summary>
        public MissingVariableException(IReadOnlyList<string> names)
            : base((names.Count == 1 ? "missing template variable: " : "missing template variables: ") + string.Join(", ", names))
        {
            Names = names.ToArray();
        }

        /// <summary>Every missing variable, in order of first appearance.</summary>
        public IReadOnlyList<string> Names { get; }
    }

    /// <summary>No mirror could deliver a manifest during start-up (see <see cref="KeepYourPromptsOptions.StartupTimeout"/>).</summary>
    public sealed class UnavailableException : KypException
    {
        /// <summary>Creates the exception.</summary>
        public UnavailableException(string message) : base(message) { }
    }

    /// <summary>A mirror returned something that does not follow the delivery protocol.</summary>
    public sealed class ProtocolException : KypException
    {
        /// <summary>Creates the exception.</summary>
        public ProtocolException(string message) : base(message) { }
    }
}
