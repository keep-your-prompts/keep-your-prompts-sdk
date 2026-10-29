package com.keepyourprompts;

/** What {@link Templates#render} does with a {@code {{variable}}} that has no value. */
public enum OnMissing {
  /** Throw {@link MissingVariableException} (the default). */
  ERROR,
  /** Leave {@code {{name}}} in the output. */
  KEEP,
  /** Replace it with an empty string. */
  EMPTY
}
