package com.keepyourprompts;

/** {@code get}, {@code prompt} or {@code render} for a name that is not in the deployed manifest. */
public class PromptNotFoundException extends KypException {
  private static final long serialVersionUID = 1L;
  private final String name;

  public PromptNotFoundException(String name, String detail) {
    super("prompt not found: \"" + name + "\"" + (detail == null || detail.isEmpty() ? "" : " (" + detail + ")"));
    this.name = name;
  }

  /** The prompt name that was asked for. */
  public String name() {
    return name;
  }
}
