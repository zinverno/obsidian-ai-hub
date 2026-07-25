export interface SemanticSettingsActionButton {
  readonly buttonEl: { readonly isConnected: boolean };
  setDisabled(value: boolean): unknown;
}

export interface SemanticSettingsActionOptions {
  buttons: readonly SemanticSettingsActionButton[];
  action(): Promise<unknown>;
  onError(): void;
  isContainerConnected(): boolean;
  refresh(): void;
}

export function semanticControlDisabled(options: {
  runnerBusy: boolean;
  statusKind: string;
  semanticEnabled: boolean;
  requiresEnabled: boolean;
}): boolean {
  return (
    options.runnerBusy ||
    options.statusKind === "initializing" ||
    options.statusKind === "indexing" ||
    (options.requiresEnabled && !options.semanticEnabled)
  );
}

export class SemanticSettingsActionRunner {
  private inFlight = false;

  get busy(): boolean {
    return this.inFlight;
  }

  async run(options: SemanticSettingsActionOptions): Promise<boolean> {
    if (this.inFlight) return false;
    this.inFlight = true;
    try {
      for (const button of options.buttons) {
        try {
          button.setDisabled(true);
        } catch {
          // A stale button cannot block the controller operation.
        }
      }
      try {
        await options.action();
      } catch {
        try {
          options.onError();
        } catch {
          // Error rendering must not turn a handled action failure into an
          // unhandled rejection.
        }
      }
    } finally {
      this.inFlight = false;
      for (const button of options.buttons) {
        try {
          if (button.buttonEl.isConnected) button.setDisabled(false);
        } catch {
          // Detached DOM is never updated.
        }
      }
      let containerConnected = false;
      try {
        containerConnected = options.isContainerConnected();
      } catch {
        // The settings tab was destroyed while the operation was pending.
      }
      if (containerConnected) {
        try {
          options.refresh();
        } catch {
          // A stale/destroyed settings DOM is best-effort only.
        }
      }
    }
    return true;
  }
}
