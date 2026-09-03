export class RagError extends Error {
  readonly cause?: unknown;

  constructor(name: string, message: string, cause?: unknown) {
    super(message);
    this.name = name;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RagValidationError extends RagError {
  constructor(message: string) {
    super("RagValidationError", message);
  }
}

export class RagInsufficientContextError extends RagError {
  constructor() {
    super(
      "RagInsufficientContextError",
      "No valid indexed Vault context was found for this question.",
    );
  }
}

export class RagGenerationError extends RagError {
  constructor(message = "Language model generation failed.", cause?: unknown) {
    super("RagGenerationError", message, cause);
  }
}

export class RagSettingsError extends RagError {
  constructor() {
    super(
      "RagSettingsError",
      "Language model settings are incomplete or invalid.",
    );
  }
}
