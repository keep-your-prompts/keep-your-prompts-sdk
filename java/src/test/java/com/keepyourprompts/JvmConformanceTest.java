package com.keepyourprompts;

import org.junit.jupiter.api.DisplayName;

@DisplayName("Conformance over HTTP (in-JVM fake CDN)")
class JvmConformanceTest extends ConformanceSuite {
  @Override
  FakeCdn.Factory factory() {
    return JvmFakeCdn.factory();
  }
}
