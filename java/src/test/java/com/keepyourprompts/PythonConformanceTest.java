package com.keepyourprompts;

import static org.junit.jupiter.api.Assumptions.assumeTrue;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;

@DisplayName("Conformance over HTTP (conformance/fake_cdn.py)")
class PythonConformanceTest extends ConformanceSuite {
  private static String python;

  @BeforeAll
  static void findPython() {
    python = PythonFakeCdn.python();
    assumeTrue(python != null, "python3 not found: skipping the fake_cdn.py run");
  }

  @Override
  FakeCdn.Factory factory() {
    return routes -> new PythonFakeCdn(python, routes);
  }
}
