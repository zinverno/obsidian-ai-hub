export class VectorStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class VectorStoreNotInitializedError extends VectorStoreError {
  constructor() {
    super("Vector store has not been initialized.");
  }
}

export class VectorValidationError extends VectorStoreError {}

export class VectorStoreCorruptionError extends VectorStoreError {}

export class VectorStoreCompatibilityError extends VectorStoreError {}

export class VectorStorePersistenceError extends VectorStoreError {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}
