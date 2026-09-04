import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";

const obsidianMocks = vi.hoisted(() => ({
  requestUrl: vi.fn<(request: RequestUrlParam) => Promise<RequestUrlResponse>>(),
}));

vi.mock("obsidian", () => ({ requestUrl: obsidianMocks.requestUrl }));

import { CompanionClient, CompanionClientError } from "./client";
import type { CompanionSettings } from "./types";

const settings: CompanionSettings = {
  enabled: true,
  endpoint: "http://127.0.0.1:27124",
  token: "companion-secret",
  timeoutMs: 500,
  vaultId: "11111111-1111-4111-8111-111111111111",
};

function response(status: number, body: unknown): RequestUrlResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: {},
    text,
    json: body,
    arrayBuffer: new TextEncoder().encode(text).buffer,
  };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  obsidianMocks.requestUrl.mockReset();
});

describe("CompanionClient", () => {
  it("sends one authenticated versioned request", async () => {
    obsidianMocks.requestUrl.mockResolvedValue(response(200, { status: "ok", protocolVersion: 1, vaultCount: 0 }));
    await new CompanionClient(settings).status();
    expect(obsidianMocks.requestUrl).toHaveBeenCalledWith(expect.objectContaining({
      url: "http://127.0.0.1:27124/v1/status",
      method: "GET",
      headers: {
        Authorization: "Bearer companion-secret",
        "x-companion-protocol-version": "1",
      },
    }));
  });

  it("maps authentication failure without exposing the token", async () => {
    const noteContent = "private note body";
    obsidianMocks.requestUrl.mockResolvedValue(response(401, { error: { code: "AUTH_REQUIRED", message: `${settings.token}: ${noteContent}` } }));
    const pending = new CompanionClient(settings).status();
    await expect(pending).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(pending).rejects.not.toThrow(settings.token);
    await expect(pending).rejects.not.toThrow(noteContent);
  });

  it("detects incompatible successful responses", async () => {
    obsidianMocks.requestUrl.mockResolvedValue(response(200, { status: "ok", protocolVersion: 2, vaultCount: 0 }));
    await expect(new CompanionClient(settings).status()).rejects.toMatchObject({ code: "PROTOCOL_VERSION_MISMATCH" });
  });

  it("rejects plaintext remote HTTP before making a request", async () => {
    expect(() => new CompanionClient({ ...settings, endpoint: "http://vault.example.com" })).toThrow(CompanionClientError);
    expect(obsidianMocks.requestUrl).not.toHaveBeenCalled();
  });

  it("handles timeout without waiting for the underlying transport", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    obsidianMocks.requestUrl.mockImplementation(() => new Promise(() => undefined));
    const pending = new CompanionClient(settings).status();
    const assertion = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it("handles AbortSignal cancellation", async () => {
    obsidianMocks.requestUrl.mockImplementation(() => new Promise(() => undefined));
    const abort = new AbortController();
    const pending = new CompanionClient(settings).status(abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  });
});
