#!/usr/bin/env python3
"""A tiny stand-in for cdn.keepyourprompts.com, used by test_http.

Serves snapshot folders (envs/<app>/<env>.json, blobs/<sha256>) under URL
prefixes, with the protocol's Cache-Control headers, strong ETags and 304s.

    fake_cdn.py --route cdn:/v1/d/kypd_test:./snap --route origin:/v1/delivery/kypd_test:./snap

Prints "PORT <n>" once listening. Control endpoints for tests:
    GET /__stats          JSON counters per route (200, 304, 404, 503, last Authorization)
    GET /__down/<route>   make a route answer 503
    GET /__up/<route>     make it answer again
"""
import argparse
import hashlib
import http.server
import json
import os
import sys
import threading

MANIFEST_CC = "public, max-age=15, stale-while-revalidate=300, stale-if-error=86400"
BLOB_CC = "public, max-age=31536000, immutable"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--route", action="append", required=True, help="name:/prefix:/dir")
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()

    routes = []
    for r in args.route:
        name, prefix, directory = r.split(":", 2)
        routes.append({"name": name, "prefix": prefix.rstrip("/"), "dir": os.path.abspath(directory)})
    lock = threading.Lock()
    stats = {r["name"]: {"200": 0, "304": 0, "404": 0, "503": 0, "auth": None} for r in routes}
    down = set()

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"  # keep-alive, so clients can reuse connections

        def send(self, code, body=b"", headers=None):
            self.send_response(code)
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if body and self.command != "HEAD":
                self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/__stats":
                with lock:
                    return self.send(200, json.dumps(stats).encode(), {"Content-Type": "application/json"})
            for verb in ("down", "up"):
                if path.startswith("/__%s/" % verb):
                    name = path[len("/__%s/" % verb):]
                    with lock:
                        (down.add if verb == "down" else down.discard)(name)
                    return self.send(200, b"ok")
            for r in routes:
                if path.startswith(r["prefix"] + "/"):
                    return self.serve(r, path[len(r["prefix"]) + 1:])
            return self.send(404, b"no route")

        def serve(self, route, rel):
            name = route["name"]
            with lock:
                stats[name]["auth"] = self.headers.get("Authorization")
                if name in down:
                    stats[name]["503"] += 1
                    return self.send(503, b"down")
            parts = rel.split("/")
            if ".." in parts or "" in parts or not (rel.startswith("envs/") or rel.startswith("blobs/")):
                return self.send(404, b"not found")
            file = os.path.join(route["dir"], *parts)
            if not os.path.isfile(file):
                with lock:
                    stats[name]["404"] += 1
                return self.send(404, b"not found")
            with open(file, "rb") as f:
                body = f.read()
            etag = '"%s"' % hashlib.sha256(body).hexdigest()[:32]
            headers = {
                "ETag": etag,
                "Cache-Control": MANIFEST_CC if rel.startswith("envs/") else BLOB_CC,
                "Content-Type": "application/json" if rel.endswith(".json") else "text/plain; charset=utf-8",
            }
            if self.headers.get("If-None-Match") == etag:
                with lock:
                    stats[name]["304"] += 1
                return self.send(304, b"", headers)
            with lock:
                stats[name]["200"] += 1
            return self.send(200, body, headers)

        do_HEAD = do_GET

        def log_message(self, *a):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print("PORT %d" % server.server_address[1], flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
