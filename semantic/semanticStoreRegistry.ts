import {
  normalizeVectorStoreBasePath,
} from "../vectorStore/localVectorStore";
import type { VectorStore } from "../vectorStore/types";
import { SemanticCompatibilityError } from "./errors";

export type SemanticStoreLifecycle =
  | "uninitialized"
  | "initializing"
  | "ready";

export interface SemanticStoreRequest<TStore extends VectorStore> {
  basePath: string;
  dimensions: number;
  embeddingSpaceId: string;
  create(): TStore;
}

export interface SemanticStoreRegistryEntry<
  TStore extends VectorStore = VectorStore,
> {
  readonly basePath: string;
  readonly dimensions: number;
  readonly embeddingSpaceId: string;
  readonly store: TStore;
  readonly lifecycle: SemanticStoreLifecycle;
  readonly initializationPromise: Promise<void> | null;
}

interface MutableEntry<TStore extends VectorStore> {
  basePath: string;
  dimensions: number;
  embeddingSpaceId: string;
  store: TStore;
  lifecycle: SemanticStoreLifecycle;
  initializationPromise: Promise<void> | null;
}

/**
 * Controller-owned registry for the one mutable VectorStore associated with a
 * normalized semantic storage path. The registry itself performs no I/O.
 */
export class SemanticStoreRegistry {
  private readonly entries = new Map<string, MutableEntry<VectorStore>>();

  getOrCreateStore<TStore extends VectorStore>(
    request: SemanticStoreRequest<TStore>,
  ): TStore {
    const basePath = normalizeVectorStoreBasePath(request.basePath);
    const existing = this.entries.get(basePath);
    if (existing) {
      if (
        existing.dimensions !== request.dimensions ||
        existing.embeddingSpaceId !== request.embeddingSpaceId
      ) {
        throw new SemanticCompatibilityError();
      }
      return existing.store as TStore;
    }

    const store = request.create();
    const entry: MutableEntry<TStore> = {
      basePath,
      dimensions: request.dimensions,
      embeddingSpaceId: request.embeddingSpaceId,
      store,
      lifecycle: "uninitialized",
      initializationPromise: null,
    };
    this.entries.set(basePath, entry);
    this.installInitializationGate(entry);
    return store;
  }

  delete(basePath: string): boolean {
    return this.entries.delete(normalizeVectorStoreBasePath(basePath));
  }

  get size(): number {
    return this.entries.size;
  }

  peek(basePath: string): SemanticStoreRegistryEntry | null {
    const entry = this.entries.get(normalizeVectorStoreBasePath(basePath));
    return entry ? { ...entry } : null;
  }

  private installInitializationGate<TStore extends VectorStore>(
    entry: MutableEntry<TStore>,
  ): void {
    const initialize = entry.store.initialize.bind(entry.store);
    entry.store.initialize = (): Promise<void> => {
      if (entry.lifecycle === "ready") return Promise.resolve();
      if (entry.initializationPromise) return entry.initializationPromise;

      entry.lifecycle = "initializing";
      let pending: Promise<void>;
      try {
        pending = initialize();
      } catch (error) {
        if (this.entries.get(entry.basePath) === entry) {
          this.entries.delete(entry.basePath);
        }
        return Promise.reject(error);
      }
      entry.initializationPromise = pending;
      void pending.then(
        () => {
          entry.lifecycle = "ready";
          entry.initializationPromise = null;
        },
        () => {
          entry.initializationPromise = null;
          if (this.entries.get(entry.basePath) === entry) {
            this.entries.delete(entry.basePath);
          }
        },
      );
      return pending;
    };
  }
}
