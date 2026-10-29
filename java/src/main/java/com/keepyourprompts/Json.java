package com.keepyourprompts;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A small, strict JSON parser (RFC 8259) so the SDK has no runtime dependencies.
 *
 * <p>Objects become {@link LinkedHashMap}, arrays {@link ArrayList}, strings {@link String}, integers
 * without fraction or exponent {@link Long} (or {@link BigInteger} when they overflow), other numbers
 * {@link Double}, {@code true}/{@code false} {@link Boolean} and {@code null} {@code null}.
 */
final class Json {
  private static final int MAX_DEPTH = 64;

  private final String s;
  private int i;

  private Json(String s) {
    this.s = s;
  }

  static Object parse(String text) {
    Json p = new Json(text);
    p.ws();
    Object v = p.value(0);
    p.ws();
    if (p.i != p.s.length()) throw p.err("trailing characters");
    return v;
  }

  private IllegalArgumentException err(String what) {
    return new IllegalArgumentException("invalid JSON at offset " + i + ": " + what);
  }

  private void ws() {
    while (i < s.length()) {
      char c = s.charAt(i);
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++;
      else break;
    }
  }

  private Object value(int depth) {
    if (depth > MAX_DEPTH) throw err("nested too deeply");
    if (i >= s.length()) throw err("unexpected end");
    char c = s.charAt(i);
    switch (c) {
      case '{':
        return object(depth);
      case '[':
        return array(depth);
      case '"':
        return string();
      case 't':
        return literal("true", Boolean.TRUE);
      case 'f':
        return literal("false", Boolean.FALSE);
      case 'n':
        return literal("null", null);
      default:
        if (c == '-' || (c >= '0' && c <= '9')) return number();
        throw err("unexpected character '" + c + "'");
    }
  }

  private Object literal(String word, Object v) {
    if (!s.startsWith(word, i)) throw err("expected " + word);
    i += word.length();
    return v;
  }

  private Map<String, Object> object(int depth) {
    Map<String, Object> m = new LinkedHashMap<>();
    i++; // {
    ws();
    if (i < s.length() && s.charAt(i) == '}') {
      i++;
      return m;
    }
    while (true) {
      ws();
      if (i >= s.length() || s.charAt(i) != '"') throw err("expected a string key");
      String k = string();
      ws();
      if (i >= s.length() || s.charAt(i) != ':') throw err("expected ':'");
      i++;
      ws();
      m.put(k, value(depth + 1));
      ws();
      if (i >= s.length()) throw err("unexpected end");
      char c = s.charAt(i++);
      if (c == '}') return m;
      if (c != ',') throw err("expected ',' or '}'");
    }
  }

  private List<Object> array(int depth) {
    List<Object> a = new ArrayList<>();
    i++; // [
    ws();
    if (i < s.length() && s.charAt(i) == ']') {
      i++;
      return a;
    }
    while (true) {
      ws();
      a.add(value(depth + 1));
      ws();
      if (i >= s.length()) throw err("unexpected end");
      char c = s.charAt(i++);
      if (c == ']') return a;
      if (c != ',') throw err("expected ',' or ']'");
    }
  }

  private String string() {
    i++; // opening quote
    StringBuilder b = null;
    int run = i;
    while (true) {
      if (i >= s.length()) throw err("unterminated string");
      char c = s.charAt(i);
      if (c == '"') {
        String out = b == null ? s.substring(run, i) : b.append(s, run, i).toString();
        i++;
        return out;
      }
      if (c < 0x20) throw err("control character in string");
      if (c != '\\') {
        i++;
        continue;
      }
      if (b == null) b = new StringBuilder();
      b.append(s, run, i);
      i++;
      if (i >= s.length()) throw err("unterminated escape");
      char e = s.charAt(i++);
      switch (e) {
        case '"': b.append('"'); break;
        case '\\': b.append('\\'); break;
        case '/': b.append('/'); break;
        case 'b': b.append('\b'); break;
        case 'f': b.append('\f'); break;
        case 'n': b.append('\n'); break;
        case 'r': b.append('\r'); break;
        case 't': b.append('\t'); break;
        case 'u':
          if (i + 4 > s.length()) throw err("bad \\u escape");
          int cp = 0;
          for (int k = 0; k < 4; k++) {
            int d = Character.digit(s.charAt(i + k), 16);
            if (d < 0) throw err("bad \\u escape");
            cp = cp * 16 + d;
          }
          i += 4;
          b.append((char) cp);
          break;
        default:
          throw err("bad escape \\" + e);
      }
      run = i;
    }
  }

  private Object number() {
    int start = i;
    if (s.charAt(i) == '-') i++;
    if (i >= s.length()) throw err("bad number");
    if (s.charAt(i) == '0') {
      i++;
    } else if (s.charAt(i) >= '1' && s.charAt(i) <= '9') {
      while (i < s.length() && Character.isDigit(s.charAt(i))) i++;
    } else {
      throw err("bad number");
    }
    boolean integral = true;
    if (i < s.length() && s.charAt(i) == '.') {
      integral = false;
      i++;
      int d = i;
      while (i < s.length() && s.charAt(i) >= '0' && s.charAt(i) <= '9') i++;
      if (i == d) throw err("bad number");
    }
    if (i < s.length() && (s.charAt(i) == 'e' || s.charAt(i) == 'E')) {
      integral = false;
      i++;
      if (i < s.length() && (s.charAt(i) == '+' || s.charAt(i) == '-')) i++;
      int d = i;
      while (i < s.length() && s.charAt(i) >= '0' && s.charAt(i) <= '9') i++;
      if (i == d) throw err("bad number");
    }
    String t = s.substring(start, i);
    if (!integral) return Double.parseDouble(t);
    BigInteger big = new BigInteger(t);
    return big.bitLength() < 64 ? (Object) big.longValue() : big;
  }
}
