package com.keepyourprompts;

/** Base class of everything the SDK throws. Unchecked, so it reads naturally from Kotlin and Scala. */
public class KypException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  public KypException(String message) {
    super(message);
  }

  public KypException(String message, Throwable cause) {
    super(message, cause);
  }
}
