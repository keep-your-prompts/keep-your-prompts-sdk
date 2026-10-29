package com.keepyourprompts;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * {@code {{name}}} templates: optional spaces inside the braces, names {@code [A-Za-z_][A-Za-z0-9_]*},
 * <code>&#123;&#123;&#123;&#123;</code> renders a literal <code>&#123;&#123;</code>. No logic, loops or escaping; values are not rendered again.
 */
public final class Templates {
  private Templates() {}

  private interface Sink {
    void literal(String s, int from, int to);

    void variable(String name, String raw);
  }

  private static boolean identStart(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
  }

  private static boolean identChar(char c) {
    return identStart(c) || (c >= '0' && c <= '9');
  }

  private static boolean space(char c) {
    return c == ' ' || c == '\t';
  }

  private static void scan(String t, Sink sink) {
    int i = 0;
    int run = 0;
    int n = t.length();
    while (i < n) {
      int open = t.indexOf("{{", i);
      if (open < 0) break;
      if (t.startsWith("{{{{", open)) {
        sink.literal(t, run, open);
        sink.literal("{{", 0, 2);
        i = run = open + 4;
        continue;
      }
      int j = open + 2;
      while (j < n && space(t.charAt(j))) j++;
      if (j < n && identStart(t.charAt(j))) {
        int start = j;
        while (j < n && identChar(t.charAt(j))) j++;
        int endName = j;
        while (j < n && space(t.charAt(j))) j++;
        if (j + 1 < n && t.charAt(j) == '}' && t.charAt(j + 1) == '}') {
          sink.literal(t, run, open);
          sink.variable(t.substring(start, endName), t.substring(open, j + 2));
          i = run = j + 2;
          continue;
        }
      }
      i = open + 2; // not a variable: keep the braces as text
    }
    sink.literal(t, run, n);
  }

  /** Renders with {@link OnMissing#ERROR}. */
  public static String render(String template, Map<String, ?> vars) {
    return render(template, vars, OnMissing.ERROR);
  }

  /**
   * Replaces each {@code {{name}}} with {@code String.valueOf(vars.get(name))}. A missing (or {@code null})
   * value is handled by {@code onMissing}; with {@link OnMissing#ERROR} every missing name is listed in the
   * {@link MissingVariableException}.
   */
  public static String render(String template, Map<String, ?> vars, OnMissing onMissing) {
    StringBuilder out = new StringBuilder(template.length() + 64);
    List<String> missing = new ArrayList<>(0);
    scan(
        template,
        new Sink() {
          @Override
          public void literal(String s, int from, int to) {
            out.append(s, from, to);
          }

          @Override
          public void variable(String name, String raw) {
            Object v = vars == null ? null : vars.get(name);
            if (v != null) {
              out.append(v);
            } else if (onMissing == OnMissing.KEEP) {
              out.append(raw);
            } else if (onMissing == OnMissing.ERROR && !missing.contains(name)) {
              missing.add(name);
            }
          }
        });
    if (!missing.isEmpty()) throw new MissingVariableException(missing);
    return out.toString();
  }

  /** Distinct variable names in order of first appearance. */
  public static List<String> variables(String template) {
    Set<String> names = new LinkedHashSet<>();
    scan(
        template,
        new Sink() {
          @Override
          public void literal(String s, int from, int to) {}

          @Override
          public void variable(String name, String raw) {
            names.add(name);
          }
        });
    return List.copyOf(names);
  }

  /** Lowercase hex SHA-256 of the UTF-8 bytes of {@code text}. */
  public static String sha256Hex(String text) {
    return sha256Hex(text.getBytes(StandardCharsets.UTF_8));
  }

  /** Lowercase hex SHA-256. */
  public static String sha256Hex(byte[] data) {
    MessageDigest md;
    try {
      md = MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 is not available", e);
    }
    byte[] d = md.digest(data);
    char[] hex = new char[64];
    final char[] digits = "0123456789abcdef".toCharArray();
    for (int k = 0; k < 32; k++) {
      hex[2 * k] = digits[(d[k] >> 4) & 0xf];
      hex[2 * k + 1] = digits[d[k] & 0xf];
    }
    return new String(hex);
  }
}
