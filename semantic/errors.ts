export class SemanticError extends Error {
  readonly cause?: unknown;

  constructor(name: string, message: string, cause?: unknown) {
    super(message);
    this.name = name;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SemanticNotReadyError extends SemanticError {
  constructor(message = "Semantic runtime is not ready.") {
    super("SemanticNotReadyError", message);
  }
}

export class SemanticSourceNotIndexedError extends SemanticNotReadyError {
  constructor() {
    super("The source note is not present in the semantic index.");
    this.name = "SemanticSourceNotIndexedError";
  }
}

export class SemanticValidationError extends SemanticError {
  constructor(message: string) {
    super("SemanticValidationError", message);
  }
}

export class SemanticProviderError extends SemanticError {
  constructor() {
    super(
      "SemanticProviderError",
      "Semantic query embedding failed. Check the embedding provider settings.",
    );
  }
}

export class SemanticStorageError extends SemanticError {
  constructor(message: string, cause?: unknown) {
    super("SemanticStorageError", message, cause);
  }
}

export class SemanticCompatibilityError extends SemanticError {
  constructor(cause?: unknown) {
    super(
      "SemanticCompatibilityError",
      "The semantic index was created with a different embedding space.",
      cause,
    );
  }
}
