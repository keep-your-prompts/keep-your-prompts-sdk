package com.keepyourprompts;

/**
 * What {@link KeepYourPrompts#renderWithMeta} returns: the rendered text and the metadata of the body used.
 *
 * @param text the rendered prompt
 * @param meta which deployed body it came from
 */
public record Rendered(String text, PromptMeta meta) {
  @Override
  public String toString() {
    return text;
  }
}
