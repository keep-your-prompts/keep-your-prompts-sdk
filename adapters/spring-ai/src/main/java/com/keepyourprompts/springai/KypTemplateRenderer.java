package com.keepyourprompts.springai;

import com.keepyourprompts.OnMissing;
import com.keepyourprompts.Templates;
import java.util.Map;
import java.util.Objects;
import org.springframework.ai.template.TemplateRenderer;

/**
 * A Spring AI {@link TemplateRenderer} for Keep Your Prompts templates: <code>{{name}}</code> variables,
 * <code>{{{{</code> for a literal <code>{{</code>, nothing else special. Rendering is the core SDK's ({@link Templates#render}), so output
 * is identical to {@code KeepYourPrompts.render}; a missing variable throws {@code MissingVariableException} unless
 * the renderer was created with {@link OnMissing#KEEP} or {@link OnMissing#EMPTY}.
 *
 * <p>Use it wherever Spring AI takes a renderer: {@code PromptTemplate.builder().renderer(...)} or
 * {@code ChatClient.builder(model).defaultTemplateRenderer(...)}.
 */
public final class KypTemplateRenderer implements TemplateRenderer {
  private final OnMissing onMissing;

  /** Strict: a missing variable throws. */
  public KypTemplateRenderer() {
    this(OnMissing.ERROR);
  }

  public KypTemplateRenderer(OnMissing onMissing) {
    this.onMissing = Objects.requireNonNull(onMissing, "onMissing");
  }

  public OnMissing onMissing() {
    return onMissing;
  }

  @Override
  public String apply(String template, Map<String, ? extends Object> variables) {
    return Templates.render(template, variables == null ? Map.of() : variables, onMissing);
  }
}
