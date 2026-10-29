package com.keepyourprompts;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Which deployed body a call used (protocol/tracing.md). Read from memory with {@link KeepYourPrompts#meta} or
 * {@link KeepYourPrompts#renderWithMeta}.
 *
 * @param name prompt name
 * @param version prompt version from the manifest
 * @param sha256 lowercase hex SHA-256 of the body used
 * @param app app slug
 * @param env environment slug
 * @param workspace workspace from the manifest
 * @param revision manifest revision held
 * @param source normalised mirror kind ({@code embedded}, {@code snapshot}, {@code cache}, {@code cdn},
 *     {@code origin}, {@code git}, {@code custom}); empty before anything is loaded
 */
public record PromptMeta(
    String name, long version, String sha256, String app, String env, String workspace, long revision, String source) {
  public PromptMeta {
    Objects.requireNonNull(name, "name");
    Objects.requireNonNull(sha256, "sha256");
    app = app == null ? "" : app;
    env = env == null ? "" : env;
    workspace = workspace == null ? "" : workspace;
    source = source == null ? "" : source;
  }

  /** The {@code kyp.*} span attributes (values are {@code String} or {@code Long}). */
  public Map<String, Object> kypAttributes() {
    Map<String, Object> a = new LinkedHashMap<>();
    a.put("kyp.prompt.name", name);
    a.put("kyp.prompt.version", version);
    a.put("kyp.prompt.sha256", sha256);
    a.put("kyp.app", app);
    a.put("kyp.env", env);
    a.put("kyp.revision", revision);
    if (!workspace.isEmpty()) a.put("kyp.workspace", workspace);
    if (!source.isEmpty()) a.put("kyp.source", source);
    return a;
  }

  /** {@link #kypAttributes()} plus {@code gen_ai.prompt.name} and {@code gen_ai.prompt.version} (a string). */
  public Map<String, Object> attributes() {
    Map<String, Object> a = kypAttributes();
    a.put("gen_ai.prompt.name", name);
    a.put("gen_ai.prompt.version", Long.toString(version));
    return a;
  }

  /** The {@code kyp.*} attributes with flat keys ({@code kyp_prompt_name}, ...), for free-form metadata. */
  public Map<String, Object> traceMetadata() {
    Map<String, Object> out = new LinkedHashMap<>();
    kypAttributes().forEach((k, v) -> out.put(k.replace('.', '_'), v));
    return out;
  }

  /** {@link #traceMetadata()}, for Langfuse observation or trace metadata. */
  public Map<String, Object> langfuseMetadata() {
    return traceMetadata();
  }

  /** {@link #traceMetadata()}, for LangSmith run metadata. */
  public Map<String, Object> langsmithMetadata() {
    return traceMetadata();
  }
}
