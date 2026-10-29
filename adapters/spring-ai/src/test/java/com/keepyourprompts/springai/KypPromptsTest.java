package com.keepyourprompts.springai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.keepyourprompts.KeepYourPrompts;
import com.keepyourprompts.MissingVariableException;
import com.keepyourprompts.OnMissing;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.MessageType;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.model.Generation;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.prompt.PromptTemplate;
import org.springframework.ai.chat.prompt.SystemPromptTemplate;

/** Runs against the real Spring AI model classes (PromptTemplate, SystemPromptTemplate, ChatClient). */
class KypPromptsTest {
  static KeepYourPrompts client;
  static KypPrompts prompts;

  @BeforeAll
  static void open() {
    client = Fixtures.v12();
    prompts = new KypPrompts(client);
  }

  @AfterAll
  static void close() {
    client.close();
  }

  @Test
  void rendererMatchesTheCoreSdk() {
    KypTemplateRenderer r = new KypTemplateRenderer();
    assertThat(r.apply("Hello {{name}}", Map.of("name", "Ana"))).isEqualTo("Hello Ana");
    assertThat(r.apply("use {{{{name}} syntax", Map.of())).isEqualTo("use {{name}} syntax");
    assertThat(r.apply("{{a}}", Map.of("a", "{{b}}", "b", "x"))).isEqualTo("{{b}}");
    assertThat(r.apply("{{ 9bad }} {{ok_1}} {json}", Map.of("ok_1", "y"))).isEqualTo("{{ 9bad }} y {json}");
    assertThatThrownBy(() -> r.apply("{{missing}}", Map.of())).isInstanceOf(MissingVariableException.class);
    assertThat(new KypTemplateRenderer(OnMissing.KEEP).apply("{{missing}} stays", Map.of())).isEqualTo("{{missing}} stays");
    assertThat(new KypTemplateRenderer(OnMissing.EMPTY).apply("[{{missing}}]", null)).isEqualTo("[]");
  }

  @Test
  void promptTemplates() {
    PromptTemplate t = prompts.promptTemplate("triage");
    assertThat(t.getTemplate()).isEqualTo(client.get("triage"));
    assertThat(t.render(Map.of("company", "Acme"))).isEqualTo(client.render("triage", Map.of("company", "Acme")));
    assertThat(t.render(Map.of("company", "Acme"))).isEqualTo("You are a support agent for Acme. Literal {{braces}} stay.");
    assertThatThrownBy(() -> t.render(Map.of())).isInstanceOf(MissingVariableException.class);

    SystemPromptTemplate s = prompts.systemPromptTemplate("greeting");
    Message m = s.createMessage(Map.of("name", "Ana", "company", "Acme"));
    assertThat(m.getMessageType()).isEqualTo(MessageType.SYSTEM);
    assertThat(m.getText()).isEqualTo("Hello Ana, welcome to Acme.");
    Prompt p = s.create(Map.of("name", "Ana", "company", "Acme"));
    assertThat(p.getInstructions()).hasSize(1);
  }

  @Test
  void messagesCarryMetadata() {
    Message sys = prompts.systemMessage("triage", Map.of("company", "Acme"));
    assertThat(sys.getMessageType()).isEqualTo(MessageType.SYSTEM);
    assertThat(sys.getMetadata())
        .containsEntry(KypPromptMetadata.NAME, "triage")
        .containsEntry(KypPromptMetadata.VERSION, 7L)
        .containsEntry(KypPromptMetadata.SHA256, "f31befda9f5a0fed97bb07f8164baf8673f4342fcca9ad37d59dafaacefc53bf");
    Message user = prompts.userMessage("greeting", Map.of("name", "Bo", "company", "Acme"));
    assertThat(user.getMessageType()).isEqualTo(MessageType.USER);
    assertThat(prompts.assistantMessage("agents/reviewer", Map.of()).getMetadata()).containsEntry(KypPromptMetadata.NAME, "agents/reviewer");
    Prompt prompt = prompts.prompt("triage", Map.of("company", "Acme"), "My invoice is wrong.", null);
    assertThat(prompt.getInstructions()).extracting(Message::getMessageType).containsExactly(MessageType.SYSTEM, MessageType.USER);
    assertThat(prompts.metadata("greeting")).isEqualTo(new KypPromptMetadata("greeting", 4, "5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d"));
  }

  @Test
  void chatClientUsesTheRendererForDeployedTemplates() {
    List<Prompt> seen = new java.util.ArrayList<>();
    ChatModel model = new ChatModel() {
      @Override
      public ChatResponse call(Prompt prompt) {
        seen.add(prompt);
        return new ChatResponse(List.of(new Generation(new AssistantMessage("ok"))));
      }
    };
    ChatClient chat = ChatClient.builder(model).defaultTemplateRenderer(prompts.renderer()).build();
    Map<String, Object> vars = new HashMap<>(Map.of("company", "Acme"));
    String answer = chat.prompt().system(s -> s.text(client.get("triage")).params(vars)).user("hi").call().content();
    assertThat(answer).isEqualTo("ok");
    assertThat(seen.get(0).getSystemMessage().getText()).isEqualTo("You are a support agent for Acme. Literal {{braces}} stay.");
  }

  @Test
  void followsDeploysWithoutRestart(@TempDir Path dir) {
    Fixtures.deploy("v12", dir);
    try (KeepYourPrompts live = Fixtures.client(dir)) {
      KypPrompts p = new KypPrompts(live);
      Map<String, Object> vars = Map.of("name", "Ana", "company", "Acme");
      assertThat(p.promptTemplate("greeting").render(vars)).isEqualTo("Hello Ana, welcome to Acme.");
      Fixtures.deploy("v13", dir);
      assertThat(live.refresh()).isTrue();
      assertThat(p.promptTemplate("greeting").render(vars)).isEqualTo("Hi Ana! Acme is glad you are here.");
      assertThat(p.metadata("greeting").version()).isEqualTo(5);
    }
  }
}
