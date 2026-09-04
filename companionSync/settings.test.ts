import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_COMPANION_SETTINGS,
  isLocalCompanionEndpoint,
  mergeCompanionSettings,
} from "./settings";

const VAULT_ID = "11111111-1111-4111-8111-111111111111";

describe("Companion settings", () => {
  it("are disabled and local by default", () => {
    expect(DEFAULT_COMPANION_SETTINGS).toMatchObject({
      enabled: false,
      endpoint: "http://127.0.0.1:27124",
      token: "",
    });
  });

  it("generates a vaultId once when none is stored", () => {
    const generate = vi.fn(() => VAULT_ID);
    const first = mergeCompanionSettings(null, generate);
    const second = mergeCompanionSettings(first, generate);
    expect(first.vaultId).toBe(VAULT_ID);
    expect(second.vaultId).toBe(VAULT_ID);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("persists endpoint and trims accidental token whitespace", () => {
    const result = mergeCompanionSettings({
      enabled: true,
      endpoint: " https://vault.example.com/ ",
      token: " token-value ",
      vaultId: VAULT_ID,
    });
    expect(result).toMatchObject({
      enabled: true,
      endpoint: "https://vault.example.com/",
      token: "token-value",
      vaultId: VAULT_ID,
    });
  });

  it("distinguishes local endpoints from remote privacy boundaries", () => {
    expect(isLocalCompanionEndpoint("http://localhost:27124")).toBe(true);
    expect(isLocalCompanionEndpoint("http://127.0.0.9:27124")).toBe(true);
    expect(isLocalCompanionEndpoint("https://vault.example.com")).toBe(false);
  });
});
