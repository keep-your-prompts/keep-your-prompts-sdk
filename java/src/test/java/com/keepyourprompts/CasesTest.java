package com.keepyourprompts;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

/** conformance/cases.json: behaviours 1 (render), 2 (variables), 3 (manifest) and the sha256 table. */
@DisplayName("Conformance cases.json")
class CasesTest {
  @SuppressWarnings("unchecked")
  static List<Map<String, Object>> section(String name) throws Exception {
    return (List<Map<String, Object>>) TestSupport.cases().get(name);
  }

  @TestFactory
  @DisplayName("1. render")
  Stream<DynamicTest> render() throws Exception {
    return section("render").stream().map(c -> DynamicTest.dynamicTest(String.valueOf(c.get("template")), () -> {
      String tmpl = (String) c.get("template");
      @SuppressWarnings("unchecked")
      Map<String, Object> vars = (Map<String, Object>) c.get("vars");
      OnMissing mode = Boolean.TRUE.equals(c.get("lenient")) ? OnMissing.KEEP : OnMissing.ERROR;
      if (c.containsKey("error")) {
        assertEquals("missing_variable", c.get("error"));
        MissingVariableException e =
            assertThrows(MissingVariableException.class, () -> Templates.render(tmpl, vars, mode));
        assertEquals(List.of(c.get("variable")), e.names());
      } else {
        assertEquals(c.get("out"), Templates.render(tmpl, vars, mode));
      }
    }));
  }

  @TestFactory
  @DisplayName("2. variables")
  Stream<DynamicTest> variables() throws Exception {
    return section("variables").stream().map(c -> DynamicTest.dynamicTest(String.valueOf(c.get("template")),
        () -> assertEquals(c.get("out"), Templates.variables((String) c.get("template")))));
  }

  @TestFactory
  @DisplayName("3. manifest")
  Stream<DynamicTest> manifest() throws Exception {
    return section("manifest").stream().map(c -> DynamicTest.dynamicTest(
        String.valueOf(c.getOrDefault("why", c.get("file"))), () -> {
          String text = c.containsKey("file")
              ? Files.readString(TestSupport.conformanceDir().resolve((String) c.get("file")))
              : toJson(c.get("json"));
          if (Boolean.TRUE.equals(c.get("valid"))) {
            Manifest m = Manifest.parse(text, "demo", "prod");
            if (c.containsKey("prompts")) assertEquals(c.get("prompts"), new ArrayList<>(m.prompts.keySet()));
            for (Manifest.Entry e : m.prompts.values()) assertTrue(e.variables() != null);
            if (c.containsKey("json")) assertEquals(List.of(), m.prompts.get("p").variables());
          } else {
            assertThrows(ProtocolException.class, () -> Manifest.parse(text, "demo", "prod"));
          }
        }));
  }

  @TestFactory
  @DisplayName("sha256")
  Stream<DynamicTest> sha256() throws Exception {
    return section("sha256").stream().map(c -> DynamicTest.dynamicTest("\"" + c.get("in") + "\"",
        () -> assertEquals(c.get("out"), Templates.sha256Hex((String) c.get("in")))));
  }

  /** Minimal serializer for the inline manifest cases (round-trips through our own parser). */
  static String toJson(Object o) {
    if (o == null) return "null";
    if (o instanceof String s) return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    if (o instanceof Map<?, ?> m) {
      StringBuilder b = new StringBuilder("{");
      for (Map.Entry<?, ?> e : m.entrySet()) {
        if (b.length() > 1) b.append(',');
        b.append(toJson(e.getKey())).append(':').append(toJson(e.getValue()));
      }
      return b.append('}').toString();
    }
    if (o instanceof List<?> l) {
      StringBuilder b = new StringBuilder("[");
      for (Object v : l) {
        if (b.length() > 1) b.append(',');
        b.append(toJson(v));
      }
      return b.append(']').toString();
    }
    return String.valueOf(o);
  }
}
