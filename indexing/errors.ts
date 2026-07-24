export class IndexingError extends Error {
  readonly cause?: unknown;

  constructor(name: string, message: string, cause?: unknown) {
    super(message);
    this.name = name;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class IndexingNotInitializedError extends IndexingError {
  constructor() {
    super(
      "IndexingNotInitializedError",
      "IndexingService must be initialized before this operation.",
    );
  }
}

export class IndexingValidationError extends IndexingError {
  constructor(message: string, cause?: unknown) {
    super("IndexingValidationError", message, cause);
  }
}

export class IndexingProviderError extends IndexingError {
  constructor(message: string, cause?: unknown) {
    super("IndexingProviderError", message, cause);
  }
}

export class IndexingProviderContractError extends IndexingProviderError {
  constructor(message: string) {
    super(message);
    this.name = "IndexingProviderContractError";
  }
}

export class IndexingCompatibilityError extends IndexingError {
  constructor(message: string, cause?: unknown) {
    super("IndexingCompatibilityError", message, cause);
  }
}

export class IndexingSourceError extends IndexingError {
  constructor(message: string, cause?: unknown) {
    super("IndexingSourceError", message, cause);
  }
}
