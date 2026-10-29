package com.keepyourprompts;

/** A mirror returned something that does not follow the delivery protocol. */
public class ProtocolException extends KypException {
  private static final long serialVersionUID = 1L;

  public ProtocolException(String message) {
    super(message);
  }
}
