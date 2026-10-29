package com.keepyourprompts.springai;

import com.keepyourprompts.Prompt;
import java.util.Map;

/**
 * Which deployed prompt produced a template or message: name, version and SHA-256 of the body.
 *
 * @param name prompt name
 * @param version prompt version from the manifest
 * @param sha256 lowercase hex SHA-256 of the body
 */
public record KypPromptMetadata(String name, long version, String sha256) {
  /** Message metadata and span attribute keys. */
  public static final String NAME = "kyp.prompt.name";

  public static final String VERSION = "kyp.prompt.version";
  public static final String SHA256 = "kyp.prompt.sha256";

  public static KypPromptMetadata of(Prompt p) {
    return new KypPromptMetadata(p.name(), p.version(), p.sha256());
  }

  /** {@code kyp.prompt.name}, {@code kyp.prompt.version}, {@code kyp.prompt.sha256}. */
  public Map<String, Object> asMap() {
    return Map.of(NAME, name, VERSION, version, SHA256, sha256);
  }
}
