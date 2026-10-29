using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;

namespace KeepYourPrompts
{
    /// <summary>What <see cref="Templates.Render"/> does with a <c>{{variable}}</c> that has no value.</summary>
    public enum OnMissing
    {
        /// <summary>Throw <see cref="MissingVariableException"/> (the default).</summary>
        Error,
        /// <summary>Leave <c>{{name}}</c> in the output.</summary>
        Keep,
        /// <summary>Replace it with an empty string.</summary>
        Empty,
    }

    /// <summary>
    /// <c>{{name}}</c> templates: optional spaces inside the braces, names <c>[A-Za-z_][A-Za-z0-9_]*</c>,
    /// <c>{{{{</c> renders a literal <c>{{</c>. No logic, loops or escaping; values are not rendered again.
    /// </summary>
    public static class Templates
    {
        private static bool IdentStart(char c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
        private static bool IdentChar(char c) => IdentStart(c) || (c >= '0' && c <= '9');
        private static bool Space(char c) => c == ' ' || c == '\t';

        private static void Scan(string t, Action<string, int, int> literal, Action<string, string> variable)
        {
            int i = 0, run = 0, n = t.Length;
            while (i < n)
            {
                int open = t.IndexOf("{{", i, StringComparison.Ordinal);
                if (open < 0) break;
                if (string.CompareOrdinal(t, open, "{{{{", 0, 4) == 0)
                {
                    literal(t, run, open);
                    literal("{{", 0, 2);
                    i = run = open + 4;
                    continue;
                }
                int j = open + 2;
                while (j < n && Space(t[j])) j++;
                if (j < n && IdentStart(t[j]))
                {
                    int start = j;
                    while (j < n && IdentChar(t[j])) j++;
                    int endName = j;
                    while (j < n && Space(t[j])) j++;
                    if (j + 1 < n && t[j] == '}' && t[j + 1] == '}')
                    {
                        literal(t, run, open);
                        variable(t.Substring(start, endName - start), t.Substring(open, j + 2 - open));
                        i = run = j + 2;
                        continue;
                    }
                }
                i = open + 2; // not a variable: keep the braces as text
            }
            literal(t, run, n);
        }

        /// <summary>
        /// Replaces each <c>{{name}}</c> with <c>vars[name]</c>. A missing (or null) value is handled by
        /// <paramref name="onMissing"/>; with <see cref="OnMissing.Error"/> every missing name is listed in the
        /// <see cref="MissingVariableException"/>.
        /// </summary>
        public static string Render(string template, IReadOnlyDictionary<string, string>? vars, OnMissing onMissing = OnMissing.Error)
        {
            if (template == null) throw new ArgumentNullException(nameof(template));
            var sb = new StringBuilder(template.Length + 64);
            List<string>? missing = null;
            Scan(
                template,
                (s, from, to) => sb.Append(s, from, to - from),
                (name, raw) =>
                {
                    string? v = null;
                    if (vars != null && vars.TryGetValue(name, out var found)) v = found;
                    if (v != null) sb.Append(v);
                    else if (onMissing == OnMissing.Keep) sb.Append(raw);
                    else if (onMissing == OnMissing.Error)
                    {
                        missing ??= new List<string>();
                        if (!missing.Contains(name)) missing.Add(name);
                    }
                });
            if (missing != null) throw new MissingVariableException(missing);
            return sb.ToString();
        }

        /// <summary>Distinct variable names in order of first appearance.</summary>
        public static IReadOnlyList<string> Variables(string template)
        {
            if (template == null) throw new ArgumentNullException(nameof(template));
            var names = new List<string>();
            Scan(template, (_, _, _) => { }, (name, _) => { if (!names.Contains(name)) names.Add(name); });
            return names;
        }

        /// <summary>Lowercase hex SHA-256 of the UTF-8 bytes of <paramref name="text"/>.</summary>
        public static string Sha256Hex(string text) => Sha256Hex(Encoding.UTF8.GetBytes(text));

        /// <summary>Lowercase hex SHA-256.</summary>
        public static string Sha256Hex(byte[] data)
        {
            byte[] d;
#if NET5_0_OR_GREATER
            d = SHA256.HashData(data);
#else
            using (var sha = SHA256.Create()) d = sha.ComputeHash(data);
#endif
            const string digits = "0123456789abcdef";
            var c = new char[64];
            for (int k = 0; k < 32; k++)
            {
                c[2 * k] = digits[d[k] >> 4];
                c[2 * k + 1] = digits[d[k] & 0xf];
            }
            return new string(c);
        }
    }
}
