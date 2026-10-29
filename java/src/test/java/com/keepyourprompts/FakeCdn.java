package com.keepyourprompts;

import java.nio.file.Path;
import java.util.Map;

/** An HTTP mirror server for tests, with the behaviour of conformance/fake_cdn.py. */
interface FakeCdn extends AutoCloseable {
  /** e.g. {@code http://127.0.0.1:41234}. */
  String base();

  void down(String route);

  void up(String route);

  /** Counter for a route: "200", "304", "404" or "503". */
  int stat(String route, String key);

  /** Last Authorization header the route saw, or null. */
  String auth(String route);

  @Override
  void close();

  /** Starts a server with routes name -> (prefix, dir). */
  interface Factory {
    FakeCdn start(Map<String, Map.Entry<String, Path>> routes) throws Exception;
  }
}
