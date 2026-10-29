package com.keepyourprompts;

import java.nio.file.Path;
import java.util.Objects;

/**
 * One copy of a workspace in the protocol layout ({@code envs/<app>/<env>.json}, {@code blobs/<sha256>}).
 *
 * @param name shown in {@link Status} and logs, e.g. {@code cdn}
 * @param url {@code https://host/base}, {@code http://...}, {@code file:///dir}, a plain path, or
 *     {@code classpath:prefix}
 * @param bearerToken sent as {@code Authorization: Bearer} (git mirror, origin); empty for none
 */
public record Mirror(String name, String url, String bearerToken) {
  public Mirror {
    Objects.requireNonNull(name, "name");
    Objects.requireNonNull(url, "url");
    bearerToken = bearerToken == null ? "" : bearerToken;
  }

  /** A folder written by {@code kyp pull}. */
  public static Mirror file(Path dir, String name) {
    return new Mirror(name, dir.toString(), "");
  }

  public static Mirror file(Path dir) {
    return file(dir, "snapshot");
  }

  /** An HTTP(S) base URL. */
  public static Mirror http(String baseUrl, String name, String bearerToken) {
    return new Mirror(name, baseUrl, bearerToken);
  }

  public static Mirror http(String baseUrl, String name) {
    return new Mirror(name, baseUrl, "");
  }

  /** A snapshot packaged as class-path resources under {@code prefix} (e.g. {@code src/main/resources/prompts}). */
  public static Mirror classpath(String prefix) {
    return new Mirror("embedded", "classpath:" + prefix, "");
  }

  @Override
  public String toString() {
    return "Mirror[" + name + ", " + url + (bearerToken.isEmpty() ? "" : ", bearer=***") + "]";
  }
}
