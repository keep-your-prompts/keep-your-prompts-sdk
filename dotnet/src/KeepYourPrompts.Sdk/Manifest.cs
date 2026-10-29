using System;
using System.Collections.Generic;
using System.Text.Json;

namespace KeepYourPrompts
{
    /// <summary>A parsed <c>envs/&lt;app&gt;/&lt;env&gt;.json</c>. Unknown fields are ignored.</summary>
    internal sealed class Manifest
    {
        internal sealed class Entry
        {
            public Entry(string sha256, long version, IReadOnlyList<string> variables)
            {
                Sha256 = sha256;
                Version = version;
                Variables = variables;
            }

            public string Sha256 { get; }
            public long Version { get; }
            public IReadOnlyList<string> Variables { get; }
        }

        public string Workspace { get; private set; } = "";
        public string App { get; private set; } = "";
        public string Env { get; private set; } = "";
        public string DeployedAt { get; private set; } = "";
        public long Revision { get; private set; }
        public SortedDictionary<string, Entry> Prompts { get; } = new SortedDictionary<string, Entry>(StringComparer.Ordinal);

        public static bool IsSlug(string? s)
        {
            if (string.IsNullOrEmpty(s) || s!.Length > 63) return false;
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || (i > 0 && c == '-');
                if (!ok) return false;
            }
            return true;
        }

        public static bool IsWorkspaceSlug(string s)
        {
            if (s.Length == 0 || s.Length > 128 || s == "." || s == "..") return false;
            foreach (char c in s)
            {
                bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.';
                if (!ok) return false;
            }
            return true;
        }

        public static bool IsSha256Hex(string s)
        {
            if (s.Length != 64) return false;
            foreach (char c in s)
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
            return true;
        }

        /// <summary>Parses and validates; throws <see cref="ProtocolException"/>. <paramref name="app"/> null skips the app/env check.</summary>
        public static Manifest Parse(byte[] utf8, string? app, string? env)
        {
            JsonDocument doc;
            try
            {
                doc = JsonDocument.Parse(utf8, new JsonDocumentOptions { MaxDepth = 64 });
            }
            catch (JsonException e)
            {
                throw new ProtocolException("manifest is not valid JSON: " + e.Message);
            }
            using (doc)
            {
                var j = doc.RootElement;
                if (j.ValueKind != JsonValueKind.Object) throw new ProtocolException("manifest is not a JSON object");
                if (j.TryGetProperty("schema", out var schema))
                {
                    if (!IsInteger(schema, out var sv) || sv != 1)
                        throw new ProtocolException("unsupported manifest schema (this SDK reads schema 1)");
                }
                var m = new Manifest
                {
                    Workspace = Str(j, "workspace", true),
                    App = Str(j, "app", true),
                    Env = Str(j, "env", true),
                    DeployedAt = Str(j, "deployed_at", false),
                };
                if (!IsWorkspaceSlug(m.Workspace)) throw new ProtocolException("manifest workspace is not a valid slug");
                if (app != null && (m.App != app || m.Env != env))
                    throw new ProtocolException("manifest is for " + m.App + "/" + m.Env + ", expected " + app + "/" + env);

                if (!j.TryGetProperty("revision", out var rev) || !IsInteger(rev, out var revision) || revision < 0)
                    throw new ProtocolException("manifest \"revision\" must be a non-negative integer");
                m.Revision = revision;

                if (!j.TryGetProperty("prompts", out var prompts) || prompts.ValueKind != JsonValueKind.Object)
                    throw new ProtocolException("manifest \"prompts\" must be an object");
                foreach (var prop in prompts.EnumerateObject())
                {
                    string name = prop.Name;
                    if (name.Length == 0 || name[0] == '/' || name[name.Length - 1] == '/' || name.Contains("//"))
                        throw new ProtocolException("invalid prompt name \"" + name + "\"");
                    var p = prop.Value;
                    if (p.ValueKind != JsonValueKind.Object) throw new ProtocolException("prompt \"" + name + "\" must be an object");
                    if (!p.TryGetProperty("sha256", out var sha) || sha.ValueKind != JsonValueKind.String)
                        throw new ProtocolException("prompt \"" + name + "\" has no sha256");
                    string hash = sha.GetString()!.ToLowerInvariant();
                    if (!IsSha256Hex(hash)) throw new ProtocolException("prompt \"" + name + "\" has an invalid sha256");
                    long version = 0;
                    if (p.TryGetProperty("version", out var ver) && IsInteger(ver, out var vv)) version = vv;
                    var vars = new List<string>();
                    if (p.TryGetProperty("variables", out var va) && va.ValueKind == JsonValueKind.Array)
                        foreach (var v in va.EnumerateArray())
                            if (v.ValueKind == JsonValueKind.String) vars.Add(v.GetString()!);
                    m.Prompts[name] = new Entry(hash, version, vars.ToArray());
                }
                return m;
            }
        }

        private static bool IsInteger(JsonElement e, out long value)
        {
            value = 0;
            if (e.ValueKind != JsonValueKind.Number) return false;
            string raw = e.GetRawText();
            if (raw.IndexOfAny(new[] { '.', 'e', 'E' }) >= 0) return false;
            return e.TryGetInt64(out value);
        }

        private static string Str(JsonElement j, string k, bool required)
        {
            if (!j.TryGetProperty(k, out var v) || v.ValueKind == JsonValueKind.Null)
            {
                if (required) throw new ProtocolException("manifest is missing \"" + k + "\"");
                return "";
            }
            if (v.ValueKind != JsonValueKind.String) throw new ProtocolException("manifest \"" + k + "\" must be a string");
            return v.GetString()!;
        }
    }
}
