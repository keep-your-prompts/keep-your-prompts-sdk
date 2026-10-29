package com.keepyourprompts;

/** No mirror could deliver a manifest during start-up (see {@code Builder.startupTimeout}). */
public class UnavailableException extends KypException {
  private static final long serialVersionUID = 1L;

  public UnavailableException(String message) {
    super(message);
  }
}
