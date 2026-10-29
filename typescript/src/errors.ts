/** Base class of every error the SDK throws. */
export class KypError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** `get` / `prompt` / `render` for a name that is not in the deployed manifest. */
export class NotFoundError extends KypError {
  readonly promptName: string;
  constructor(promptName: string, detail?: string) {
    super(`prompt not found: "${promptName}"${detail ? ` (${detail})` : ''}`);
    this.promptName = promptName;
  }
}

/** `render` was called without a value for one or more `{{variables}}`. */
export class MissingVariableError extends KypError {
  readonly names: readonly string[];
  constructor(names: string[]) {
    super(`missing template variable${names.length === 1 ? '' : 's'}: ${names.join(', ')}`);
    this.names = Object.freeze([...names]);
  }
}

/** No mirror could deliver a manifest during start-up (see `startupTimeout`). */
export class UnavailableError extends KypError {}

/** A mirror returned something that does not follow the delivery protocol. */
export class ProtocolError extends KypError {}
