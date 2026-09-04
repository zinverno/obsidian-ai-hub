import { describe, expect, it } from "vitest";
import { redact } from "../src/logging/logger.js";

describe("structured log redaction", () => {
  it("redacts configured secrets, bearer values, and sensitive keys recursively", () => {
    const secret = "companion-super-secret";
    const value = redact({
      message: `failed for ${secret}`,
      Authorization: `Bearer ${secret}`,
      nested: { token: secret, apiKey: "provider-key" },
    }, [secret]);
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("provider-key");
    expect(serialized).toContain("[REDACTED]");
  });
});
