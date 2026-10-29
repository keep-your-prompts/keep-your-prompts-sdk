package com.keepyourprompts.springai;

import static org.assertj.core.api.Assertions.assertThat;

import com.keepyourprompts.KeepYourPrompts;
import com.keepyourprompts.OnMissing;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Spring Boot's ApplicationContextRunner over the real auto-configuration (as listed in AutoConfiguration.imports). */
class KypAutoConfigurationTest {
  private final ApplicationContextRunner runner = new ApplicationContextRunner()
      .withConfiguration(AutoConfigurations.of(KypAutoConfiguration.class));

  private String snapshot() {
    return Fixtures.DIR.resolve("v12").toString();
  }

  @Test
  void createsClientAndPromptsFromProperties() {
    runner
        .withPropertyValues("kyp.app=demo", "kyp.snapshot-dir=" + snapshot(), "kyp.poll-interval=1h")
        .run(ctx -> {
          assertThat(ctx).hasSingleBean(KeepYourPrompts.class).hasSingleBean(KypPrompts.class).hasSingleBean(KypTemplateRenderer.class);
          KypPrompts p = ctx.getBean(KypPrompts.class);
          assertThat(p.render("triage", Map.of("company", "Acme"))).startsWith("You are a support agent for Acme.");
          assertThat(ctx.getBean(KeepYourPrompts.class).status().source()).isEqualTo("snapshot");
        });
  }

  @Test
  void onMissingProperty() {
    runner
        .withPropertyValues("kyp.app=demo", "kyp.snapshot-dir=" + snapshot(), "kyp.on-missing=keep")
        .run(ctx -> {
          assertThat(ctx.getBean(KypTemplateRenderer.class).onMissing()).isEqualTo(OnMissing.KEEP);
          assertThat(ctx.getBean(KypPrompts.class).render("greeting", Map.of("name", "Ana"))).isEqualTo("Hello Ana, welcome to {{ company }}.");
        });
  }

  @Test
  void backsOffWithoutAnApp() {
    runner.run(ctx -> assertThat(ctx).doesNotHaveBean(KeepYourPrompts.class).doesNotHaveBean(KypPrompts.class));
  }

  @Test
  void canBeDisabled() {
    runner
        .withPropertyValues("kyp.enabled=false", "kyp.app=demo", "kyp.snapshot-dir=" + snapshot())
        .run(ctx -> assertThat(ctx).doesNotHaveBean(KeepYourPrompts.class));
  }

  @Test
  void usesTheApplicationsClient() {
    runner.withUserConfiguration(OwnClient.class).run(ctx -> {
      assertThat(ctx).hasSingleBean(KeepYourPrompts.class);
      assertThat(ctx.getBean(KypPrompts.class).client()).isSameAs(ctx.getBean("myClient"));
    });
  }

  @Configuration(proxyBeanMethods = false)
  static class OwnClient {
    @Bean(destroyMethod = "close")
    KeepYourPrompts myClient() {
      return Fixtures.v12();
    }
  }
}
