import { describe, expect, it, vi } from "vitest";
import {
  semanticControlDisabled,
  SemanticSettingsActionRunner,
} from "./semanticSettingsActionRunner";

class FakeButton {
  disabled = false;
  buttonEl = { isConnected: true };
  throwWhenDetached = false;

  setDisabled(value: boolean): void {
    if (this.throwWhenDetached && !this.buttonEl.isConnected) {
      throw new Error("stale button touched");
    }
    this.disabled = value;
  }
}

interface ManualGate {
  promise: Promise<void>;
  resolve(): void;
}

function manualGate(): ManualGate {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function options(
  buttons: FakeButton[],
  action: () => Promise<unknown>,
) {
  const state = { connected: true };
  const onError = vi.fn();
  const refresh = vi.fn();
  return {
    state,
    onError,
    refresh,
    value: {
      buttons,
      action,
      onError,
      isContainerConnected: () => state.connected,
      refresh,
    },
  };
}

describe("SemanticSettingsActionRunner", () => {
  it("disables mutating controls while off and every control while busy", () => {
    expect(
      semanticControlDisabled({
        runnerBusy: false,
        statusKind: "disabled",
        semanticEnabled: false,
        requiresEnabled: true,
      }),
    ).toBe(true);
    expect(
      semanticControlDisabled({
        runnerBusy: false,
        statusKind: "disabled",
        semanticEnabled: false,
        requiresEnabled: false,
      }),
    ).toBe(false);
    expect(
      semanticControlDisabled({
        runnerBusy: true,
        statusKind: "ready",
        semanticEnabled: true,
        requiresEnabled: false,
      }),
    ).toBe(true);
    expect(
      semanticControlDisabled({
        runnerBusy: false,
        statusKind: "indexing",
        semanticEnabled: true,
        requiresEnabled: false,
      }),
    ).toBe(true);
  });

  it("disables every button during await and restores the UI", async () => {
    const runner = new SemanticSettingsActionRunner();
    const buttons = [new FakeButton(), new FakeButton()];
    const gate = manualGate();
    const control = options(buttons, () => gate.promise);
    const pending = runner.run(control.value);
    expect(runner.busy).toBe(true);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(control.refresh).not.toHaveBeenCalled();

    gate.resolve();
    await expect(pending).resolves.toBe(true);
    expect(runner.busy).toBe(false);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    expect(control.refresh).toHaveBeenCalledOnce();
  });

  it("handles rejection, restores buttons, and permits retry", async () => {
    const runner = new SemanticSettingsActionRunner();
    const button = new FakeButton();
    const failed = options([button], async () => {
      throw new Error("Bearer sk-private response body");
    });
    await expect(runner.run(failed.value)).resolves.toBe(true);
    expect(failed.onError).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(false);

    const retryAction = vi.fn(async () => undefined);
    const retry = options([button], retryAction);
    await runner.run(retry.value);
    expect(retryAction).toHaveBeenCalledOnce();
  });

  it("deduplicates repeated clicks while an action is pending", async () => {
    const runner = new SemanticSettingsActionRunner();
    const button = new FakeButton();
    const gate = manualGate();
    const firstAction = vi.fn(() => gate.promise);
    const duplicateAction = vi.fn(async () => undefined);
    const first = runner.run(options([button], firstAction).value);
    await expect(
      runner.run(options([button], duplicateAction).value),
    ).resolves.toBe(false);
    expect(firstAction).toHaveBeenCalledOnce();
    expect(duplicateAction).not.toHaveBeenCalled();
    gate.resolve();
    await first;
  });

  it("does not update detached buttons or a closed settings tab", async () => {
    const runner = new SemanticSettingsActionRunner();
    const button = new FakeButton();
    const gate = manualGate();
    const control = options([button], () => gate.promise);
    const pending = runner.run(control.value);
    button.buttonEl.isConnected = false;
    button.throwWhenDetached = true;
    control.state.connected = false;
    gate.resolve();
    await expect(pending).resolves.toBe(true);
    expect(control.refresh).not.toHaveBeenCalled();
  });
});
