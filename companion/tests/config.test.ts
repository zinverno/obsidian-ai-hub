import { describe, expect, it } from "vitest";
import { ConfigurationError, isLoopbackHost, loadConfig } from "../src/config.js";

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { COMPANION_TOKEN: "test-secret", ...overrides };
}

describe("Companion configuration", () => {
  it("uses a loopback-only default", () => {
    expect(loadConfig(environment())).toMatchObject({
      host: "127.0.0.1",
      port: 27124,
      allowRemoteBind: false,
      mcp: { enabled: false, token: "", vaultId: "", embeddingTimeoutMs: 30_000 },
    });
  });

  it.each(["0", "65536", "12.5", "abc"])("rejects invalid port %s", (port) => {
    expect(() => loadConfig(environment({ PORT: port }))).toThrow(ConfigurationError);
  });

  it("rejects an empty token", () => {
    expect(() => loadConfig({ COMPANION_TOKEN: "  " })).toThrow(/COMPANION_TOKEN/u);
  });

  it("rejects an invalid host", () => {
    expect(() => loadConfig(environment({ HOST: "https://bad host/" }))).toThrow(/HOST/u);
  });

  it("rejects a non-loopback bind without explicit permission", () => {
    expect(() => loadConfig(environment({ HOST: "0.0.0.0" }))).toThrow(/ALLOW_REMOTE_BIND/u);
  });

  it("accepts a non-loopback bind with explicit permission", () => {
    expect(loadConfig(environment({ HOST: "0.0.0.0", ALLOW_REMOTE_BIND: "true" })).host).toBe("0.0.0.0");
  });

  it("recognizes IPv4 and IPv6 loopback only", () => {
    expect(isLoopbackHost("127.42.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("192.168.1.2")).toBe(false);
  });

  it("requires a distinct token and one UUID vault scope when MCP is enabled", () => {
    expect(() => loadConfig(environment({ MCP_ENABLED: "true" }))).toThrow(/MCP_TOKEN/u);
    expect(() => loadConfig(environment({ MCP_ENABLED: "true", MCP_TOKEN: "read-only" }))).toThrow(/MCP_VAULT_ID/u);
    expect(() => loadConfig(environment({
      MCP_ENABLED: "true",
      MCP_TOKEN: "test-secret",
      MCP_VAULT_ID: "11111111-1111-4111-8111-111111111111",
    }))).toThrow(/differ/u);
    expect(loadConfig(environment({
      MCP_ENABLED: "true",
      MCP_TOKEN: "read-only-secret",
      MCP_VAULT_ID: "11111111-1111-4111-8111-111111111111",
      MCP_EMBEDDING_API_KEY: "provider-secret",
      MCP_EMBEDDING_TIMEOUT_MS: "5000",
    }))).toMatchObject({
      mcp: {
        enabled: true,
        token: "read-only-secret",
        vaultId: "11111111-1111-4111-8111-111111111111",
        embeddingApiKey: "provider-secret",
        embeddingTimeoutMs: 5000,
      },
    });
  });

  it("rejects invalid MCP settings", () => {
    expect(() => loadConfig(environment({ MCP_VAULT_ID: "not-a-uuid" }))).toThrow(/MCP_VAULT_ID/u);
    expect(() => loadConfig(environment({ MCP_ENABLED: "yes" }))).toThrow(/MCP_ENABLED/u);
    expect(() => loadConfig(environment({ MCP_EMBEDDING_TIMEOUT_MS: "499" }))).toThrow(/MCP_EMBEDDING_TIMEOUT_MS/u);
  });
});
