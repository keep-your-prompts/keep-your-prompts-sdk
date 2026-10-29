package com.keepyourprompts;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

/** A parsed {@code envs/<app>/<env>.json}. Unknown fields are ignored. */
final class Manifest {
  record Entry(String sha256, long version, List<String> variables) {}

  final String workspace;
  final String app;
  final String env;
  final String deployedAt;
  final long revision;
  final Map<String, Entry> prompts; // sorted by name

  private Manifest(
      String workspace, String app, String env, String deployedAt, long revision, Map<String, Entry> prompts) {
    this.workspace = workspace;
    this.app = app;
    this.env = env;
    this.deployedAt = deployedAt;
    this.revision = revision;
    this.prompts = Collections.unmodifiableMap(prompts);
  }

  static boolean isSlug(String s) {
    if (s == null || s.isEmpty() || s.length() > 63) return false;
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      boolean ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || (i > 0 && c == '-');
      if (!ok) return false;
    }
    return true;
  }

  static boolean isWorkspaceSlug(String s) {
    if (s == null || s.isEmpty() || s.length() > 128 || s.equals(".") || s.equals("..")) return false;
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-'
          || c == '_' || c == '.';
      if (!ok) return false;
    }
    return true;
  }

  static boolean isSha256Hex(String s) {
    if (s.length() != 64) return false;
    for (int i = 0; i < 64; i++) {
      char c = s.charAt(i);
      if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    }
    return true;
  }

  /** Parses and validates; throws {@link ProtocolException}. */
  static Manifest parse(String text, String app, String env) {
    Object root;
    try {
      root = Json.parse(text);
    } catch (IllegalArgumentException e) {
      throw new ProtocolException("manifest is not valid JSON: " + e.getMessage());
    }
    if (!(root instanceof Map)) throw new ProtocolException("manifest is not a JSON object");
    @SuppressWarnings("unchecked")
    Map<String, Object> j = (Map<String, Object>) root;

    if (j.containsKey("schema")) {
      Object schema = j.get("schema");
      if (!(schema instanceof Long) || (Long) schema != 1L)
        throw new ProtocolException("unsupported manifest schema (this SDK reads schema 1)");
    }
    String workspace = str(j, "workspace", true);
    String mApp = str(j, "app", true);
    String mEnv = str(j, "env", true);
    String deployedAt = str(j, "deployed_at", false);
    if (!isWorkspaceSlug(workspace)) throw new ProtocolException("manifest workspace is not a valid slug");
    if (app != null && (!mApp.equals(app) || !mEnv.equals(env)))
      throw new ProtocolException("manifest is for " + mApp + "/" + mEnv + ", expected " + app + "/" + env);

    Object rev = j.get("revision");
    if (!(rev instanceof Long) || (Long) rev < 0)
      throw new ProtocolException("manifest \"revision\" must be a non-negative integer");

    Object ps = j.get("prompts");
    if (!(ps instanceof Map)) throw new ProtocolException("manifest \"prompts\" must be an object");
    Map<String, Entry> prompts = new TreeMap<>();
    for (Map.Entry<?, ?> e : ((Map<?, ?>) ps).entrySet()) {
      String name = (String) e.getKey();
      if (name.isEmpty() || name.startsWith("/") || name.endsWith("/") || name.contains("//"))
        throw new ProtocolException("invalid prompt name \"" + name + "\"");
      if (!(e.getValue() instanceof Map)) throw new ProtocolException("prompt \"" + name + "\" must be an object");
      Map<?, ?> p = (Map<?, ?>) e.getValue();
      Object sha = p.get("sha256");
      if (!(sha instanceof String)) throw new ProtocolException("prompt \"" + name + "\" has no sha256");
      String hash = ((String) sha).toLowerCase(Locale.ROOT);
      if (!isSha256Hex(hash)) throw new ProtocolException("prompt \"" + name + "\" has an invalid sha256");
      Object ver = p.get("version");
      long version = ver instanceof Long ? (Long) ver : 0L;
      List<String> vars = new ArrayList<>();
      if (p.get("variables") instanceof List) {
        for (Object v : (List<?>) p.get("variables")) if (v instanceof String) vars.add((String) v);
      }
      prompts.put(name, new Entry(hash, version, List.copyOf(vars)));
    }
    return new Manifest(workspace, mApp, mEnv, deployedAt, (Long) rev, prompts);
  }

  private static String str(Map<String, Object> j, String k, boolean required) {
    Object v = j.get(k);
    if (v == null) {
      if (required) throw new ProtocolException("manifest is missing \"" + k + "\"");
      return "";
    }
    if (!(v instanceof String)) throw new ProtocolException("manifest \"" + k + "\" must be a string");
    return (String) v;
  }
}
