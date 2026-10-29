using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace KeepYourPrompts.Tests
{
    /// <summary>An HTTP mirror server for tests with the behaviour of conformance/fake_cdn.py.</summary>
    internal interface IFakeCdn : IDisposable
    {
        string Base { get; }
        void Down(string route);
        void Up(string route);
        int Stat(string route, string key);
        string? Auth(string route);
    }

    internal static class FakeCdn
    {
        private static readonly Lazy<string?> PythonPath = new Lazy<string?>(FindPython);

        public static string? Python => PythonPath.Value;

        private static string? FindPython()
        {
            foreach (var candidate in new[] { "python3", "python" })
            {
                try
                {
                    var psi = new ProcessStartInfo(candidate, "-c \"import sys; assert sys.version_info >= (3, 7)\"")
                    {
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false,
                    };
                    using var p = Process.Start(psi)!;
                    p.WaitForExit(10000);
                    if (p.HasExited && p.ExitCode == 0) return candidate;
                }
                catch (Exception e) when (e is System.ComponentModel.Win32Exception || e is InvalidOperationException)
                {
                }
            }
            return null;
        }

        /// <summary>"listener" (in-process, always) and "python" (conformance/fake_cdn.py, when python3 exists).</summary>
        public static IEnumerable<object[]> Kinds()
        {
            yield return new object[] { "listener" };
            if (Python != null) yield return new object[] { "python" };
        }

        public static IFakeCdn Start(string kind, IReadOnlyDictionary<string, (string Prefix, string Dir)> routes) =>
            kind == "python" ? new PythonFakeCdn(Python!, routes) : new ListenerFakeCdn(routes);
    }

    /// <summary>In-process port of fake_cdn.py on HttpListener.</summary>
    internal sealed class ListenerFakeCdn : IFakeCdn
    {
        private const string ManifestCc = "public, max-age=15, stale-while-revalidate=300, stale-if-error=86400";
        private const string BlobCc = "public, max-age=31536000, immutable";

        private readonly HttpListener _listener = new HttpListener();
        private readonly List<(string Name, string Prefix, string Dir)> _routes;
        private readonly Dictionary<string, Dictionary<string, int>> _stats = new Dictionary<string, Dictionary<string, int>>();
        private readonly Dictionary<string, string?> _auth = new Dictionary<string, string?>();
        private readonly HashSet<string> _down = new HashSet<string>();
        private readonly int _port;

        public ListenerFakeCdn(IReadOnlyDictionary<string, (string Prefix, string Dir)> routes)
        {
            _routes = routes.Select(kv => (kv.Key, kv.Value.Prefix.TrimEnd('/'), kv.Value.Dir)).ToList();
            foreach (var r in _routes) _stats[r.Name] = new Dictionary<string, int> { ["200"] = 0, ["304"] = 0, ["404"] = 0, ["503"] = 0 };
            var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            _port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            _listener.Prefixes.Add("http://127.0.0.1:" + _port + "/");
            _listener.Start();
            _ = Task.Run(LoopAsync);
        }

        public string Base => "http://127.0.0.1:" + _port;

        public void Down(string route) { lock (this) _down.Add(route); }
        public void Up(string route) { lock (this) _down.Remove(route); }
        public int Stat(string route, string key) { lock (this) return _stats[route][key]; }
        public string? Auth(string route) { lock (this) return _auth.TryGetValue(route, out var a) ? a : null; }

        public void Dispose()
        {
            try { _listener.Stop(); _listener.Close(); } catch (ObjectDisposedException) { }
        }

        private async Task LoopAsync()
        {
            while (_listener.IsListening)
            {
                HttpListenerContext ctx;
                try { ctx = await _listener.GetContextAsync(); }
                catch (Exception) { return; }
                _ = Task.Run(() => Handle(ctx));
            }
        }

        private static void Send(HttpListenerContext ctx, int code, byte[] body, IDictionary<string, string>? headers = null)
        {
            try
            {
                var resp = ctx.Response;
                resp.StatusCode = code;
                if (headers != null) foreach (var kv in headers) resp.Headers[kv.Key] = kv.Value;
                if (code != 304) resp.ContentLength64 = body.Length;
                if (body.Length > 0 && code != 304 && ctx.Request.HttpMethod != "HEAD") resp.OutputStream.Write(body, 0, body.Length);
                resp.Close();
            }
            catch (Exception e) when (e is HttpListenerException || e is ObjectDisposedException || e is IOException)
            {
            }
        }

        private void Handle(HttpListenerContext ctx)
        {
            string path = ctx.Request.Url!.AbsolutePath;
            foreach (var r in _routes)
            {
                if (path.StartsWith(r.Prefix + "/", StringComparison.Ordinal))
                {
                    Serve(ctx, r, path.Substring(r.Prefix.Length + 1));
                    return;
                }
            }
            Send(ctx, 404, Encoding.UTF8.GetBytes("no route"));
        }

        private void Serve(HttpListenerContext ctx, (string Name, string Prefix, string Dir) r, string rel)
        {
            lock (this)
            {
                _auth[r.Name] = ctx.Request.Headers["Authorization"];
                if (_down.Contains(r.Name))
                {
                    _stats[r.Name]["503"]++;
                    Send(ctx, 503, Encoding.UTF8.GetBytes("down"));
                    return;
                }
            }
            var parts = rel.Split('/');
            if (parts.Contains("..") || parts.Contains("") || !(rel.StartsWith("envs/", StringComparison.Ordinal) || rel.StartsWith("blobs/", StringComparison.Ordinal)))
            {
                Send(ctx, 404, Encoding.UTF8.GetBytes("not found"));
                return;
            }
            string file = Path.Combine(new[] { r.Dir }.Concat(parts).ToArray());
            if (!File.Exists(file))
            {
                lock (this) _stats[r.Name]["404"]++;
                Send(ctx, 404, Encoding.UTF8.GetBytes("not found"));
                return;
            }
            byte[] body = File.ReadAllBytes(file);
            string etag = "\"" + Templates.Sha256Hex(body).Substring(0, 32) + "\"";
            var headers = new Dictionary<string, string>
            {
                ["ETag"] = etag,
                ["Cache-Control"] = rel.StartsWith("envs/", StringComparison.Ordinal) ? ManifestCc : BlobCc,
                ["Content-Type"] = rel.EndsWith(".json", StringComparison.Ordinal) ? "application/json" : "text/plain; charset=utf-8",
            };
            if (ctx.Request.Headers["If-None-Match"] == etag)
            {
                lock (this) _stats[r.Name]["304"]++;
                Send(ctx, 304, Array.Empty<byte>(), headers);
                return;
            }
            lock (this) _stats[r.Name]["200"]++;
            Send(ctx, 200, body, headers);
        }
    }

    /// <summary>Runs conformance/fake_cdn.py as a child process.</summary>
    internal sealed class PythonFakeCdn : IFakeCdn
    {
        private readonly Process _process;
        private readonly int _port;
        private static readonly HttpClient Http = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(5) };

        public PythonFakeCdn(string python, IReadOnlyDictionary<string, (string Prefix, string Dir)> routes)
        {
            var psi = new ProcessStartInfo(python) { RedirectStandardOutput = true, UseShellExecute = false };
            psi.ArgumentList.Add(Path.Combine(TestSupport.ConformanceDir, "fake_cdn.py"));
            foreach (var kv in routes)
            {
                psi.ArgumentList.Add("--route");
                psi.ArgumentList.Add(kv.Key + ":" + kv.Value.Prefix + ":" + kv.Value.Dir);
            }
            _process = Process.Start(psi)!;
            string? line = _process.StandardOutput.ReadLine();
            if (line == null || !line.StartsWith("PORT ", StringComparison.Ordinal))
            {
                _process.Kill();
                throw new InvalidOperationException("fake_cdn.py did not start: " + line);
            }
            _port = int.Parse(line.Substring(5).Trim());
        }

        public string Base => "http://127.0.0.1:" + _port;

        private string Ctl(string path) => Http.GetStringAsync(Base + path).GetAwaiter().GetResult();

        public void Down(string route) => Ctl("/__down/" + route);
        public void Up(string route) => Ctl("/__up/" + route);

        private JsonElement Stats(string route)
        {
            using var doc = JsonDocument.Parse(Ctl("/__stats"));
            return doc.RootElement.GetProperty(route).Clone();
        }

        public int Stat(string route, string key) => Stats(route).GetProperty(key).GetInt32();

        public string? Auth(string route)
        {
            var a = Stats(route).GetProperty("auth");
            return a.ValueKind == JsonValueKind.Null ? null : a.GetString();
        }

        public void Dispose()
        {
            try
            {
                if (!_process.HasExited)
                {
                    _process.Kill();
                    _process.WaitForExit(5000);
                }
            }
            catch (InvalidOperationException)
            {
            }
            _process.Dispose();
        }
    }
}
