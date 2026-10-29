using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using Xunit;

namespace KeepYourPrompts.Tests
{
    /// <summary>conformance/cases.json: behaviours 1 (render), 2 (variables), 3 (manifest) and sha256.</summary>
    public class CasesTests
    {
        private static JsonElement Section(string name)
        {
            using var doc = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(TestSupport.ConformanceDir, "cases.json")));
            return doc.RootElement.GetProperty(name).Clone();
        }

        public static IEnumerable<object[]> Cases(string name) =>
            Section(name).EnumerateArray().Select((c, i) => new object[] { i, c.GetRawText() });

        private static Dictionary<string, string> Vars(JsonElement c) =>
            c.TryGetProperty("vars", out var v) ? v.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString()!) : new Dictionary<string, string>();

        [Theory, MemberData(nameof(Cases), "render")]
        public void Render(int index, string json)
        {
            var c = JsonDocument.Parse(json).RootElement;
            string tmpl = c.GetProperty("template").GetString()!;
            var mode = c.TryGetProperty("lenient", out var l) && l.GetBoolean() ? OnMissing.Keep : OnMissing.Error;
            if (c.TryGetProperty("error", out var err))
            {
                Assert.Equal("missing_variable", err.GetString());
                var e = Assert.Throws<MissingVariableException>(() => Templates.Render(tmpl, Vars(c), mode));
                Assert.Equal(new[] { c.GetProperty("variable").GetString()! }, e.Names);
            }
            else
            {
                Assert.Equal(c.GetProperty("out").GetString(), Templates.Render(tmpl, Vars(c), mode));
            }
            Assert.True(index >= 0);
        }

        [Theory, MemberData(nameof(Cases), "variables")]
        public void Variables(int index, string json)
        {
            var c = JsonDocument.Parse(json).RootElement;
            var want = c.GetProperty("out").EnumerateArray().Select(x => x.GetString()!).ToArray();
            Assert.Equal(want, Templates.Variables(c.GetProperty("template").GetString()!));
            Assert.True(index >= 0);
        }

        [Theory, MemberData(nameof(Cases), "manifest")]
        public void Manifest(int index, string json)
        {
            var c = JsonDocument.Parse(json).RootElement;
            byte[] text = c.TryGetProperty("file", out var f)
                ? File.ReadAllBytes(Path.Combine(TestSupport.ConformanceDir, f.GetString()!))
                : Encoding.UTF8.GetBytes(c.GetProperty("json").GetRawText());
            if (c.GetProperty("valid").GetBoolean())
            {
                var m = KeepYourPrompts.Manifest.Parse(text, "demo", "prod");
                if (c.TryGetProperty("prompts", out var names))
                    Assert.Equal(names.EnumerateArray().Select(x => x.GetString()!).ToArray(), m.Prompts.Keys.ToArray());
                if (c.TryGetProperty("json", out _)) Assert.Empty(m.Prompts["p"].Variables);
            }
            else
            {
                Assert.Throws<ProtocolException>(() => KeepYourPrompts.Manifest.Parse(text, "demo", "prod"));
            }
            Assert.True(index >= 0);
        }

        [Theory, MemberData(nameof(Cases), "sha256")]
        public void Sha256(int index, string json)
        {
            var c = JsonDocument.Parse(json).RootElement;
            Assert.Equal(c.GetProperty("out").GetString(), Templates.Sha256Hex(c.GetProperty("in").GetString()!));
            Assert.True(index >= 0);
        }
    }
}
