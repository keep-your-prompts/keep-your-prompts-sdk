package com.keepyourprompts.springai;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * {@code kyp.*} properties. Unset properties fall back to the {@code KYP_*} environment variables the core SDK
 * reads ({@code KYP_APP}, {@code KYP_ENV}, {@code KYP_DELIVERY_KEY}, ...).
 */
@ConfigurationProperties(prefix = "kyp")
public class KypProperties {
  /** Turn the auto-configuration off. */
  private boolean enabled = true;
  /** App slug. */
  private String app;
  /** Environment slug (default {@code prod}). */
  private String env;
  /** Read-only delivery key ({@code kypd_...}). Keep it server-side. */
  private String deliveryKey;
  /** A snapshot folder shipped with the app. */
  private String snapshotDir;
  /** A snapshot on the classpath, e.g. {@code kyp} for {@code src/main/resources/kyp/envs/...}. */
  private String snapshotClasspath;
  /** Disk cache written by the SDK. */
  private String cacheDir;
  /** Git mirror base URL and its read token. */
  private String gitMirror;

  private String gitToken;
  /** How often the manifest is revalidated (default 30s). */
  private Duration pollInterval;
  /** Start with no prompts instead of failing when nothing can be loaded. */
  private boolean startEmpty;
  /** What templates do with a missing variable: {@code error} (default), {@code keep} or {@code empty}. */
  private String onMissing = "error";

  public boolean isEnabled() {
    return enabled;
  }

  public void setEnabled(boolean enabled) {
    this.enabled = enabled;
  }

  public String getApp() {
    return app;
  }

  public void setApp(String app) {
    this.app = app;
  }

  public String getEnv() {
    return env;
  }

  public void setEnv(String env) {
    this.env = env;
  }

  public String getDeliveryKey() {
    return deliveryKey;
  }

  public void setDeliveryKey(String deliveryKey) {
    this.deliveryKey = deliveryKey;
  }

  public String getSnapshotDir() {
    return snapshotDir;
  }

  public void setSnapshotDir(String snapshotDir) {
    this.snapshotDir = snapshotDir;
  }

  public String getSnapshotClasspath() {
    return snapshotClasspath;
  }

  public void setSnapshotClasspath(String snapshotClasspath) {
    this.snapshotClasspath = snapshotClasspath;
  }

  public String getCacheDir() {
    return cacheDir;
  }

  public void setCacheDir(String cacheDir) {
    this.cacheDir = cacheDir;
  }

  public String getGitMirror() {
    return gitMirror;
  }

  public void setGitMirror(String gitMirror) {
    this.gitMirror = gitMirror;
  }

  public String getGitToken() {
    return gitToken;
  }

  public void setGitToken(String gitToken) {
    this.gitToken = gitToken;
  }

  public Duration getPollInterval() {
    return pollInterval;
  }

  public void setPollInterval(Duration pollInterval) {
    this.pollInterval = pollInterval;
  }

  public boolean isStartEmpty() {
    return startEmpty;
  }

  public void setStartEmpty(boolean startEmpty) {
    this.startEmpty = startEmpty;
  }

  public String getOnMissing() {
    return onMissing;
  }

  public void setOnMissing(String onMissing) {
    this.onMissing = onMissing;
  }
}
