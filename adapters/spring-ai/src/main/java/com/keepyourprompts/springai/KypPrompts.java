package com.keepyourprompts.springai;

import com.keepyourprompts.KeepYourPrompts;
import com.keepyourprompts.Prompt;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.prompt.ChatOptions;
import org.springframework.ai.chat.prompt.PromptTemplate;
import org.springframework.ai.chat.prompt.SystemPromptTemplate;

/**
 * Spring AI templates, messages and prompts from deployed Keep Your Prompts prompts.
 *
 * <p>Every method reads the client's memory (no network) and returns objects built from the version deployed at
 * that moment, so call them per request to follow deploys without a restart. Templates use a
 * {@link KypTemplateRenderer}, so <code>{{name}}</code> variables render exactly like the core SDK (strict by default).
 * Messages carry {@code kyp.prompt.name}, {@code kyp.prompt.version} and {@code kyp.prompt.sha256} in their
 * metadata.
 */
public class KypPrompts {
  private final KeepYourPrompts client;
  private final KypTemplateRenderer renderer;

  public KypPrompts(KeepYourPrompts client) {
    this(client, new KypTemplateRenderer());
  }

  public KypPrompts(KeepYourPrompts client, KypTemplateRenderer renderer) {
    this.client = Objects.requireNonNull(client, "client");
    this.renderer = Objects.requireNonNull(renderer, "renderer");
  }

  public KeepYourPrompts client() {
    return client;
  }

  public KypTemplateRenderer renderer() {
    return renderer;
  }

  /** Name, version and sha256 of the deployed prompt. Throws {@code PromptNotFoundException}. */
  public KypPromptMetadata metadata(String name) {
    return KypPromptMetadata.of(client.prompt(name));
  }

  /** A {@link PromptTemplate} for the deployed prompt (user message by default). */
  public PromptTemplate promptTemplate(String name) {
    return PromptTemplate.builder().template(client.prompt(name).text()).renderer(renderer).build();
  }

  /** A {@link SystemPromptTemplate} for the deployed prompt. */
  public SystemPromptTemplate systemPromptTemplate(String name) {
    return SystemPromptTemplate.builder().template(client.prompt(name).text()).renderer(renderer).build();
  }

  /** The rendered text. */
  public String render(String name, Map<String, ?> variables) {
    return renderer.apply(client.prompt(name).text(), variables);
  }

  /** A system message with the prompt's metadata. */
  public Message systemMessage(String name, Map<String, ?> variables) {
    Prompt p = client.prompt(name);
    return SystemMessage.builder().text(renderer.apply(p.text(), variables)).metadata(meta(p)).build();
  }

  /** A user message with the prompt's metadata. */
  public Message userMessage(String name, Map<String, ?> variables) {
    Prompt p = client.prompt(name);
    return UserMessage.builder().text(renderer.apply(p.text(), variables)).metadata(meta(p)).build();
  }

  /** An assistant message (for few-shot turns) with the prompt's metadata. */
  public Message assistantMessage(String name, Map<String, ?> variables) {
    Prompt p = client.prompt(name);
    return AssistantMessage.builder().content(renderer.apply(p.text(), variables)).properties(meta(p)).build();
  }

  /** A {@link org.springframework.ai.chat.prompt.Prompt} with the deployed prompt as a user message. */
  public org.springframework.ai.chat.prompt.Prompt prompt(String name, Map<String, ?> variables) {
    return new org.springframework.ai.chat.prompt.Prompt(userMessage(name, variables));
  }

  /** A {@link org.springframework.ai.chat.prompt.Prompt} with the deployed prompt as a user message and options. */
  public org.springframework.ai.chat.prompt.Prompt prompt(String name, Map<String, ?> variables, ChatOptions options) {
    return new org.springframework.ai.chat.prompt.Prompt(List.of(userMessage(name, variables)), options);
  }

  /**
   * A {@link org.springframework.ai.chat.prompt.Prompt} with a deployed system prompt followed by a user message.
   */
  public org.springframework.ai.chat.prompt.Prompt prompt(
      String systemName, Map<String, ?> systemVariables, String userText, ChatOptions options) {
    List<Message> messages = List.of(systemMessage(systemName, systemVariables), new UserMessage(userText));
    return options == null
        ? new org.springframework.ai.chat.prompt.Prompt(messages)
        : new org.springframework.ai.chat.prompt.Prompt(messages, options);
  }

  private static Map<String, Object> meta(Prompt p) {
    return new HashMap<>(KypPromptMetadata.of(p).asMap());
  }
}
