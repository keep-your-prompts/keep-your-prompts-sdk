package com.keepyourprompts;

import java.util.List;

/** {@code render} was called without a value for one or more {@code {{variables}}}. */
public class MissingVariableException extends KypException {
  private static final long serialVersionUID = 1L;
  private final List<String> names;

  public MissingVariableException(List<String> names) {
    super((names.size() == 1 ? "missing template variable: " : "missing template variables: ")
        + String.join(", ", names));
    this.names = List.copyOf(names);
  }

  /** Every missing variable, in order of first appearance. */
  public List<String> names() {
    return names;
  }
}
