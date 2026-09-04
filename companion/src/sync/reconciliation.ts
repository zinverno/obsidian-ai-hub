import type { CompanionStorage } from "../storage/companionStorage.js";
import type {
  ReconciliationPlanRequest,
  ReconciliationPlanResponse,
  SyncBatchRequest,
  SyncBatchResponse,
} from "../protocol/types.js";

export class ReconciliationService {
  constructor(private readonly storage: CompanionStorage) {}

  plan(vaultId: string, request: ReconciliationPlanRequest): Promise<ReconciliationPlanResponse> {
    return this.storage.planReconciliation(
      vaultId,
      request.generation,
      request.descriptor,
      request.notes,
    );
  }

  apply(vaultId: string, request: SyncBatchRequest): Promise<SyncBatchResponse> {
    return this.storage.applyBatch(vaultId, request);
  }
}
