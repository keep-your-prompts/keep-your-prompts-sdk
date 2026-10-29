using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;

namespace KeepYourPrompts.Tests
{
    internal static class TestSupport
    {
        public const string GreetingV4 = "Hello {{name}}, welcome to {{ company }}.";
        public const string GreetingV5 = "Hi {{name}}! {{company}} is glad you are here.";

        public static string ConformanceDir
        {
            get
            {
                var env = Environment.GetEnvironmentVariable("KYP_CONFORMANCE_DIR");
                if (!string.IsNullOrEmpty(env)) return Path.GetFullPath(env);
                var attr = typeof(TestSupport).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
                    .First(a => a.Key == "KypConformanceDir");
                return attr.Value!;
            }
        }

        public static string Fixture(string name) => Path.Combine(ConformanceDir, "fixtures", name);

        /// <summary>Deploy like the server does: blobs first, then the manifest by rename.</summary>
        public static void Deploy(string fixture, string dir)
        {
            string src = Fixture(fixture);
            Directory.CreateDirectory(Path.Combine(dir, "blobs"));
            foreach (var b in Directory.GetFiles(Path.Combine(src, "blobs")))
                File.Copy(b, Path.Combine(dir, "blobs", Path.GetFileName(b)), true);
            string envDir = Path.Combine(dir, "envs", "demo");
            Directory.CreateDirectory(envDir);
            string tmp = Path.Combine(envDir, "prod.json.new");
            File.Copy(Path.Combine(src, "envs", "demo", "prod.json"), tmp, true);
            // Windows: the rename can briefly collide with the fake server reading the old file.
            for (int attempt = 0; ; attempt++)
            {
                try
                {
                    File.Move(tmp, Path.Combine(envDir, "prod.json"), true);
                    return;
                }
                catch (Exception e) when ((e is IOException || e is UnauthorizedAccessException) && attempt < 50)
                {
                    System.Threading.Thread.Sleep(20);
                }
            }
        }

        public static KeepYourPromptsOptions Quiet() => new KeepYourPromptsOptions { App = "demo", Env = "prod", LogLevel = KypLogLevel.Off };

        public static async Task<bool> Eventually(Func<bool> cond, TimeSpan timeout)
        {
            var end = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < end)
            {
                if (cond()) return true;
                await Task.Delay(20);
            }
            return cond();
        }
    }

    internal sealed class TempDir : IDisposable
    {
        public TempDir()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "kyp-test-" + Guid.NewGuid().ToString("N").Substring(0, 12));
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public string Sub(string name) => System.IO.Path.Combine(Path, name);

        public void Dispose()
        {
            try { Directory.Delete(Path, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
