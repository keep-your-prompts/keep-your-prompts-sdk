package com.keepyourprompts.springai;

import com.keepyourprompts.KeepYourPrompts;
import com.keepyourprompts.OnMissing;
import java.nio.file.Path;
import java.util.Locale;
import org.springframework.ai.chat.prompt.PromptTemplate;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;

/**
 * Spring Boot auto-configuration: a {@link KeepYourPrompts} client from {@code kyp.*} properties (or the
 * {@code KYP_*} environment variables), a {@link KypTemplateRenderer} and a {@link KypPrompts} bean. Each bean
 * steps aside when the application defines its own.
 */
@AutoConfiguration
@ConditionalOnClass({PromptTemplate.class, KeepYourPrompts.class})
@ConditionalOnProperty(prefix = "kyp", name = "enabled", havingValue = "true", matchIfMissing = true)
@EnableConfigurationProperties(KypProperties.class)
public class KypAutoConfiguration {

  /** Created when {@code kyp.app} (or {@code KYP_APP}, through Spring's relaxed binding) is set. */
  @Bean(destroyMethod = "close")
  @ConditionalOnMissingBean
  @ConditionalOnProperty(prefix = "kyp", name = "app")
  public KeepYourPrompts keepYourPrompts(KypProperties p) {
    KeepYourPrompts.Builder b = KeepYourPrompts.builderFromEnv();
    if (has(p.getApp())) b.app(p.getApp());
    if (has(p.getEnv())) b.env(p.getEnv());
    if (has(p.getDeliveryKey())) b.deliveryKey(p.getDeliveryKey());
    if (has(p.getSnapshotDir())) b.snapshotDir(Path.of(p.getSnapshotDir()));
    if (has(p.getSnapshotClasspath())) b.snapshotFromClasspath(p.getSnapshotClasspath());
    if (has(p.getCacheDir())) b.cacheDir(Path.of(p.getCacheDir()));
    if (has(p.getGitMirror())) b.gitMirror(p.getGitMirror(), p.getGitToken() == null ? "" : p.getGitToken());
    if (p.getPollInterval() != null) b.pollInterval(p.getPollInterval());
    if (p.isStartEmpty()) b.startEmpty(true);
    return b.build();
  }

  @Bean
  @ConditionalOnMissingBean
  public KypTemplateRenderer kypTemplateRenderer(KypProperties p) {
    return new KypTemplateRenderer(OnMissing.valueOf(p.getOnMissing().trim().toUpperCase(Locale.ROOT)));
  }

  @Bean
  @ConditionalOnMissingBean
  @ConditionalOnBean(KeepYourPrompts.class)
  public KypPrompts kypPrompts(KeepYourPrompts client, KypTemplateRenderer renderer) {
    return new KypPrompts(client, renderer);
  }

  private static boolean has(String s) {
    return s != null && !s.isBlank();
  }
}
