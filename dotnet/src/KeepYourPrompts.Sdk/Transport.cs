using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace KeepYourPrompts
{
    internal enum FetchKind { Ok, NotModified, NotFound, Failed }

    internal readonly struct FetchResult
    {
        public FetchResult(FetchKind kind, byte[]? body, string etag, string error)
        {
            Kind = kind;
            Body = body;
            ETag = etag;
            Error = error;
        }

        public FetchKind Kind { get; }
        public byte[]? Body { get; }
        public string ETag { get; }
        public string Error { get; }

        public static FetchResult Ok(byte[] body, string etag) => new FetchResult(FetchKind.Ok, body, etag, "");
        public static FetchResult NotFound(string error) => new FetchResult(FetchKind.NotFound, null, "", error);
        public static FetchResult Failed(string error) => new FetchResult(FetchKind.Failed, null, "", error);
        public FetchResult WithError(string error) => new FetchResult(Kind, Body, ETag, error);
    }

    internal enum MirrorKind { Embedded, File, Cache, Http }

    internal static class Transport
    {
        public const int MaxBody = 16 << 20; // 16 MiB: far above any manifest or prompt

        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

        public static MirrorKind KindOf(string url)
        {
            if (url.StartsWith("embedded:", StringComparison.Ordinal)) return MirrorKind.Embedded;
            if (url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                return MirrorKind.Http;
            return MirrorKind.File;
        }

        public static string FileUrlToPath(string url) =>
            url.StartsWith("file:", StringComparison.OrdinalIgnoreCase) ? new Uri(url).LocalPath : url;

        public static string JoinUrl(string b, string rel) => b.EndsWith("/", StringComparison.Ordinal) ? b + rel : b + "/" + rel;

        public static string Combine(string root, string rel) => Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar));

        /// <summary>Strict UTF-8: a blob that is not UTF-8 is a protocol error.</summary>
        public static bool TryUtf8(byte[] data, out string text)
        {
            try
            {
                text = StrictUtf8.GetString(data);
                return true;
            }
            catch (DecoderFallbackException)
            {
                text = "";
                return false;
            }
        }

        public static FetchResult ReadFile(string path)
        {
            try
            {
                return FetchResult.Ok(File.ReadAllBytes(path), "");
            }
            catch (FileNotFoundException)
            {
                return FetchResult.NotFound("no such file: " + path);
            }
            catch (DirectoryNotFoundException)
            {
                return FetchResult.NotFound("no such file: " + path);
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException)
            {
                return File.Exists(path) ? FetchResult.Failed("cannot read " + path + ": " + e.Message) : FetchResult.NotFound("no such file: " + path);
            }
        }

        // Embedded resources, indexed once per assembly with '\' normalised to '/' (RecursiveDir on Windows).
        private static readonly Dictionary<Assembly, Dictionary<string, string>> ResourceIndex = new Dictionary<Assembly, Dictionary<string, string>>();

        public static FetchResult ReadResource(Assembly asm, string prefix, string rel)
        {
            Dictionary<string, string> index;
            lock (ResourceIndex)
            {
                if (!ResourceIndex.TryGetValue(asm, out index!))
                {
                    index = new Dictionary<string, string>(StringComparer.Ordinal);
                    foreach (var n in asm.GetManifestResourceNames()) index[n.Replace('\\', '/')] = n;
                    ResourceIndex[asm] = index;
                }
            }
            string want = prefix.Length == 0 ? rel : prefix + "/" + rel;
            if (!index.TryGetValue(want, out var actual)) return FetchResult.NotFound("no such resource: " + want);
            using (var s = asm.GetManifestResourceStream(actual))
            {
                if (s == null) return FetchResult.NotFound("no such resource: " + want);
                var ms = new MemoryStream();
                s.CopyTo(ms);
                return FetchResult.Ok(ms.ToArray(), "");
            }
        }

        private static long _counter;

        /// <summary>Write a temp file, flush to disk, then rename over <paramref name="path"/>.</summary>
        public static void AtomicWrite(string path, byte[] data)
        {
            string dir = Path.GetDirectoryName(Path.GetFullPath(path))!;
            Directory.CreateDirectory(dir);
            string tmp = path + ".tmp-" + Guid.NewGuid().ToString("N").Substring(0, 12) + "-" + Interlocked.Increment(ref _counter);
            try
            {
                using (var fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    fs.Write(data, 0, data.Length);
                    fs.Flush(true);
                }
#if NETCOREAPP3_0_OR_GREATER
                File.Move(tmp, path, true);
#else
                if (File.Exists(path)) File.Replace(tmp, path, null);
                else File.Move(tmp, path);
#endif
            }
            finally
            {
                try { if (File.Exists(tmp)) File.Delete(tmp); } catch (IOException) { }
            }
        }
    }

    /// <summary>One HTTP client per SDK client: keep-alive, HTTP/2 over TLS, gzip, system proxy (HTTPS_PROXY).</summary>
    internal sealed class HttpTransport : IDisposable
    {
        private readonly HttpClient _client;
        private readonly TimeSpan _requestTimeout;

        public HttpTransport(TimeSpan connectTimeout, TimeSpan requestTimeout, string userAgent, Func<HttpMessageHandler>? factory)
        {
            HttpMessageHandler handler;
            if (factory != null)
            {
                handler = factory();
            }
            else
            {
#if NET5_0_OR_GREATER
                handler = new SocketsHttpHandler
                {
                    ConnectTimeout = connectTimeout,
                    AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
                    PooledConnectionLifetime = TimeSpan.FromMinutes(10),
                };
#else
                handler = new HttpClientHandler { AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate };
#endif
            }
            _client = new HttpClient(handler, disposeHandler: true) { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
            _client.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", userAgent);
            _requestTimeout = requestTimeout;
        }

        /// <summary>GET with optional If-None-Match and bearer token, bounded by the request timeout and <paramref name="deadline"/>.</summary>
        public async Task<FetchResult> GetAsync(string url, string etag, string bearer, DateTime deadline, CancellationToken ct)
        {
            var timeout = _requestTimeout;
            if (deadline != DateTime.MaxValue)
            {
                var left = deadline - DateTime.UtcNow;
                if (left <= TimeSpan.Zero) return FetchResult.Failed("timed out");
                if (left < timeout) timeout = left;
            }
            using (var cts = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                cts.CancelAfter(timeout);
                HttpRequestMessage req;
                try
                {
                    req = new HttpRequestMessage(HttpMethod.Get, url);
                }
                catch (UriFormatException e)
                {
                    return FetchResult.Failed("invalid URL: " + e.Message);
                }
                using (req)
                {
                    if (url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) req.Version = HttpVersion.Version11;
                    else
                    {
#if NET5_0_OR_GREATER
                        req.Version = HttpVersion.Version20;
                        req.VersionPolicy = HttpVersionPolicy.RequestVersionOrLower;
#endif
                    }
                    if (etag.Length > 0) req.Headers.TryAddWithoutValidation("If-None-Match", etag);
                    if (bearer.Length > 0) req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + bearer);
                    try
                    {
                        using (var resp = await _client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token).ConfigureAwait(false))
                        {
                            int code = (int)resp.StatusCode;
                            string tag = resp.Headers.ETag?.ToString() ?? "";
                            if (code == 304) return new FetchResult(FetchKind.NotModified, null, tag, "");
                            if (code == 404 || code == 410) return FetchResult.NotFound("HTTP " + code);
                            if (code < 200 || code >= 300) return FetchResult.Failed("HTTP " + code);
                            if (resp.Content.Headers.ContentLength > Transport.MaxBody) return FetchResult.Failed("response larger than 16 MiB");
#if NET5_0_OR_GREATER
                            var stream = await resp.Content.ReadAsStreamAsync(cts.Token).ConfigureAwait(false);
#else
                            var stream = await resp.Content.ReadAsStreamAsync().ConfigureAwait(false);
#endif
                            using (stream)
                            {
                                var ms = new MemoryStream();
                                var buf = new byte[81920];
                                int n;
                                while ((n = await stream.ReadAsync(buf, 0, buf.Length, cts.Token).ConfigureAwait(false)) > 0)
                                {
                                    ms.Write(buf, 0, n);
                                    if (ms.Length > Transport.MaxBody) return FetchResult.Failed("response larger than 16 MiB");
                                }
                                return FetchResult.Ok(ms.ToArray(), tag);
                            }
                        }
                    }
                    catch (OperationCanceledException)
                    {
                        return FetchResult.Failed(ct.IsCancellationRequested ? "cancelled" : "timed out");
                    }
                    catch (HttpRequestException e)
                    {
                        return FetchResult.Failed(e.InnerException != null ? e.Message + " (" + e.InnerException.Message + ")" : e.Message);
                    }
                    catch (IOException e)
                    {
                        return FetchResult.Failed(e.Message);
                    }
                    catch (ObjectDisposedException)
                    {
                        return FetchResult.Failed("closed");
                    }
                }
            }
        }

        public void Dispose() => _client.Dispose();
    }
}
