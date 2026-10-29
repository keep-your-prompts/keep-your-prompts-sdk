package com.keepyourprompts;

import java.util.List;
import java.util.Map;

/**
 * A deployed prompt.
 *
 * @param name prompt name, may contain {@code /} (e.g. {@code agents/reviewer})
 * @param version prompt version from the manifest
 * @param sha256 lowercase hex SHA-256 of {@code text}
 * @param variables declared variables (or those found in the text when the manifest lists none)
 * @param text the raw template
 */
public record Prompt(String name, long version, String sha256, List<String> variables, String text) {
  public Prompt {
    variables = List.copyOf(variables);
  }

  /** Renders the template; a missing variable throws {@link MissingVariableException}. */
  public String render(Map<String, ?> vars) {
    return Templates.render(text, vars, OnMissing.ERROR);
  }

  public String render(Map<String, ?> vars, OnMissing onMissing) {
    return Templates.render(text, vars, onMissing);
  }
}
