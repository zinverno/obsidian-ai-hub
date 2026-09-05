import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadQdrantConfig } from "../src/config.js";
import { collectionName, indexPoint, indexSpec, pointId, QdrantClientIndex, QdrantIndexError } from "../src/search/qdrantIndex.js";
import { descriptor, VAULT_A, VAULT_B } from "./fixtures.js";

const secret = "super-secret-qdrant";
const config = loadQdrantConfig({ QDRANT_ENABLED: "true", QDRANT_API_KEY: secret });
const spec = indexSpec(config.collectionPrefix, {
  vaultId: VAULT_A, protocolVersion: 1, exists: true, generation: 7, revision: 12,
  descriptor: descriptor(), noteCount: 1, chunkCount: 1,
}, "test-build");
const record = { chunkId: "logical-chunk", path: "Private.md", ordinal: 0, headingPath: ["heading"],
  source: { startOffset: 0, endOffset: 1, startLine: 0, endLine: 1 }, vector: new Float32Array([1, 0, 0]) };
const point = indexPoint(spec, record);
function response(result: unknown): Response {
  return new Response(JSON.stringify({ status: "ok", result }), { headers: { "content-type": "application/json" } });
}
function stub(): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/exists")) return response({ exists: true });
    if (url.pathname.endsWith("/count")) return response({ count: spec.count });
    if (url.pathname.endsWith("/query")) return response({ points: [{ id: point.id, score: 1, payload: point.payload }] });
    if (init?.method === "GET") return response({ status: "green", config: {
      params: { vectors: { size: 3, distance: "Cosine" } }, metadata: { vaultAuditOwner: spec.owner },
    } });
    return response({ status: "completed", operation_id: 1 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Qdrant configuration and identity", () => {
  it("is disabled by default with local URL and bounded timeout", () => {
    expect(loadQdrantConfig({})).toEqual({ enabled: false, url: "http://127.0.0.1:6333", apiKey: "",
      timeoutMs: 5000, collectionPrefix: "vault_audit", allowInsecureRemoteHttp: false });
  });
  it.each(["http://127.0.0.1:6333", "http://localhost:6333", "http://[::1]:6333", "https://q.example", "https://q.example/proxy"])("accepts safe URL %s", (url) => {
    expect(loadQdrantConfig({ QDRANT_URL: url }).url).toBe(url);
  });
  it.each(["junk", "ftp://localhost", `http://user:${secret}@localhost`, `https://q.example/?key=${secret}`, "https://q.example/#fragment"])("rejects unsafe URL without echoing %s", (url) => {
    expect(() => loadQdrantConfig({ QDRANT_URL: url })).toThrow(/QDRANT_URL/u);
    try { loadQdrantConfig({ QDRANT_URL: url }); } catch (error) { expect(String(error)).not.toContain(secret); }
  });
  it.each(["http://q.example:6333", "http://192.168.0.2:6333", "http://[::ffff:7f00:1]:6333"])("requires explicit remote HTTP override for %s", (url) => {
    expect(() => loadQdrantConfig({ QDRANT_URL: url })).toThrow(/QDRANT_ALLOW_INSECURE_REMOTE_HTTP/u);
    expect(loadQdrantConfig({ QDRANT_URL: url, QDRANT_ALLOW_INSECURE_REMOTE_HTTP: "true" }).allowInsecureRemoteHttp).toBe(true);
  });
  it.each([{ QDRANT_ENABLED: "yes" }, { QDRANT_TIMEOUT_MS: "0" }, { QDRANT_TIMEOUT_MS: "120001" },
    { QDRANT_COLLECTION_PREFIX: "../notes" }, { QDRANT_COLLECTION_PREFIX: "x".repeat(33) }])("rejects invalid options %j", (environment) => {
    expect(() => loadQdrantConfig(environment)).toThrow();
  });
  it("hashes collection identities without content or paths and separates spaces and vaults", () => {
    const name = collectionName("vault_audit", "/absolute/private/vault", "space with content");
    expect(name).toMatch(/^vault_audit_[a-f0-9]{32}_[a-f0-9]{32}$/u);
    expect(name).toBe(collectionName("vault_audit", "/absolute/private/vault", "space with content"));
    expect(name).not.toMatch(/absolute|private|content/u);
    expect(collectionName("vault_audit", VAULT_A, "space")).not.toBe(collectionName("vault_audit", VAULT_B, "space"));
    expect(collectionName("vault_audit", VAULT_A, "space")).not.toBe(collectionName("vault_audit", VAULT_A, "other"));
  });
  it("uses deterministic collision-resistant UUID point identity", () => {
    expect(pointId(VAULT_A, "chunk")).toBe(pointId(VAULT_A, "chunk"));
    expect(pointId(VAULT_A, "chunk")).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    expect(pointId(VAULT_A, "chunk")).not.toBe(pointId(VAULT_B, "chunk"));
    expect(pointId("ab", "c")).not.toBe(pointId("a", "bc"));
  });
  it("point payload has only retrieval identity and never full Markdown or chunk text", () => {
    const payload = indexPoint(spec, { ...record, text: "# PRIVATE MARKDOWN", content: "full private Markdown" } as typeof record).payload;
    expect(Object.keys(payload).sort()).toEqual(["buildId", "chunkId", "embeddingSpaceId", "generation", "noteKey", "revision", "vaultId"]);
    expect(JSON.stringify(payload)).not.toMatch(/PRIVATE|Markdown|Private.md|heading/u);
    expect(point.vector).toEqual([1, 0, 0]);
  });
  it.each([[1, 0], [2, 0, 0], [Number.NaN, 0, 0], [0, 0, 0]].map((vector) => ({ vector })))("rejects invalid stored vector %j without converting it", ({ vector }) => {
    expect(() => indexPoint(spec, { ...record, vector: new Float32Array(vector) })).toThrow();
  });
});

describe("official Qdrant SDK adapter", () => {
  it("creates a cosine collection of exact dimensions with ownership metadata", async () => {
    const fetch = stub();
    fetch.mockResolvedValueOnce(response({ exists: false })).mockResolvedValueOnce(response(true));
    const index = new QdrantClientIndex(config); await index.ensureCollection(spec);
    const creation = fetch.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(creation[1]!.body as string)).toEqual({ vectors: { size: 3, distance: "Cosine" }, metadata: { vaultAuditOwner: spec.owner } });
  });
  it.each([{ size: 4, distance: "Cosine" }, { size: 3, distance: "Dot" }])("rejects incompatible collection %j without clearing it", async (vectors) => {
    const fetch = stub(); fetch.mockResolvedValueOnce(response({ exists: true })).mockResolvedValueOnce(response({ status: "green",
      config: { params: { vectors }, metadata: { vaultAuditOwner: spec.owner } } }));
    await expect(new QdrantClientIndex(config).ensureCollection(spec)).rejects.toBeInstanceOf(QdrantIndexError);
    expect(fetch.mock.calls).toHaveLength(2);
  });
  it("never clears an unknown owner's collection", async () => {
    const fetch = stub(); fetch.mockResolvedValueOnce(response({ status: "green", config: {
      params: { vectors: { size: 3, distance: "Cosine" } }, metadata: { vaultAuditOwner: "foreign" },
    } }));
    await expect(new QdrantClientIndex(config).clear(spec)).rejects.toBeInstanceOf(QdrantIndexError);
    expect(fetch.mock.calls).toHaveLength(1);
  });
  it("upserts bounded points, deletes hashed note identities and waits for mutation completion", async () => {
    const fetch = stub(); const index = new QdrantClientIndex(config);
    await index.upsert(spec, [point]); await index.deleteNotes(spec, [record.path]); await index.stamp(spec);
    expect(fetch.mock.calls.every(([url]) => String(url).includes("wait=true"))).toBe(true);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ points: [point] });
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(record.path);
    await expect(index.upsert(spec, Array.from({ length: 129 }, () => point))).rejects.toBeInstanceOf(QdrantIndexError);
    await expect(index.upsert(spec, [{ ...point, vector: [1, 0] }])).rejects.toBeInstanceOf(QdrantIndexError);
  });
  it("requires completed rather than merely acknowledged mutations", async () => {
    const fetch = stub(); fetch.mockResolvedValueOnce(response({ status: "acknowledged" }));
    await expect(new QdrantClientIndex(config).upsert(spec, [point])).rejects.toBeInstanceOf(QdrantIndexError);
  });
  it("search verifies exact counts, filters current state, preserves cosine and stable ordering", async () => {
    const fetch = stub(); const actual = await new QdrantClientIndex(config).search(spec, new Float32Array([1, 0, 0]), 1);
    expect(actual).toEqual([{ chunkId: record.chunkId, score: 1 }]);
    const count = fetch.mock.calls.filter(([url]) => String(url).endsWith("/count"));
    expect(count).toHaveLength(2); expect(count.every(([, init]) => JSON.parse(init!.body as string).exact === true)).toBe(true);
    const body = JSON.parse(fetch.mock.calls.at(-1)![1]!.body as string) as { filter: unknown; with_vector: boolean };
    expect(body.with_vector).toBe(false); expect(JSON.stringify(body.filter)).toContain("test-build");
  });
  it("sorts all candidates by score then chunkId before limiting", async () => {
    const fetch = stub(); const many = { ...spec, count: 3 };
    fetch.mockImplementation(async (input) => {
      const path = String(input);
      if (path.endsWith("/count")) return response({ count: 3 });
      if (path.endsWith("/query")) return response({ points: ["z", "a", "b"].map((chunkId) => ({ id: pointId(VAULT_A, chunkId),
        score: chunkId === "b" ? 0 : 1, payload: { ...point.payload, chunkId } })) });
      return response({ status: "green", config: { params: { vectors: { size: 3, distance: "Cosine" } }, metadata: { vaultAuditOwner: spec.owner } } });
    });
    expect(await new QdrantClientIndex(config).search(many, new Float32Array([1, 0, 0]), 2)).toEqual([{ chunkId: "a", score: 1 }, { chunkId: "z", score: 1 }]);
  });
  it("rejects a bounded window cutting a larger exact tie so SQLite can resolve it", async () => {
    const fetch = stub();
    fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/count")) return response({ count: 300 });
      if (String(input).endsWith("/query")) return response({ points: Array.from({ length: JSON.parse(init!.body as string).limit as number }, (_, i) => {
        const chunkId = `id-${i}`; return { id: pointId(VAULT_A, chunkId), score: 1, payload: { ...point.payload, chunkId } };
      }) });
      return response({ status: "green", config: { params: { vectors: { size: 3, distance: "Cosine" } }, metadata: { vaultAuditOwner: spec.owner } } });
    });
    await expect(new QdrantClientIndex(config).search({ ...spec, count: 300 }, new Float32Array([1, 0, 0]), 1)).rejects.toBeInstanceOf(QdrantIndexError);
  });
  it.each(["missing", "empty", "partial", "stale"])("rejects %s index before querying", async (mode) => {
    const fetch = stub();
    if (mode === "missing") fetch.mockResolvedValueOnce(new Response(secret, { status: 404 }));
    else {
      const original = fetch.getMockImplementation()!;
      let counts = 0;
      fetch.mockImplementation((input, init) => String(input).endsWith("/count")
        ? Promise.resolve(response({ count: mode === "stale" && ++counts === 1 ? 1 : 0 })) : original(input, init));
    }
    await expect(new QdrantClientIndex(config).search(spec, new Float32Array([1, 0, 0]), 1)).rejects.toThrow();
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/query"))).toBe(false);
  });
  it.each([[], [{ id: point.id, score: 1, payload: { ...point.payload, chunkId: "forged" } }],
    [{ id: point.id, score: 1, payload: { ...point.payload, generation: 6 } }],
    [{ id: point.id, score: 1, payload: { ...point.payload, embeddingSpaceId: "wrong" } }],
    [{ id: point.id, score: 2, payload: point.payload }], [{ id: point.id, score: 1 }]].map((points) => ({ points })))("rejects malformed search results %j", async ({ points }) => {
    const fetch = stub(); const original = fetch.getMockImplementation()!;
    fetch.mockImplementation((input, init) => String(input).endsWith("/query") ? Promise.resolve(response({ points })) : original(input, init));
    await expect(new QdrantClientIndex(config).search(spec, new Float32Array([1, 0, 0]), 1)).rejects.toBeInstanceOf(QdrantIndexError);
  });
  it.each([1.0000004, -1.0000004])("clamps only Float32 cosine roundoff %s", async (score) => {
    const fetch = stub(); const original = fetch.getMockImplementation()!;
    fetch.mockImplementation((input, init) => String(input).endsWith("/query")
      ? Promise.resolve(response({ points: [{ id: point.id, score, payload: point.payload }] })) : original(input, init));
    expect(await new QdrantClientIndex(config).search(spec, new Float32Array([1, 0, 0]), 1))
      .toEqual([{ chunkId: record.chunkId, score: Math.sign(score) }]);
  });
  it("rejects malformed API key characters with sanitized configuration and constructor errors", () => {
    expect(() => loadQdrantConfig({ QDRANT_API_KEY: `${secret}\ninvalid` })).toThrow("QDRANT_API_KEY must contain printable ASCII characters.");
    expect(() => new QdrantClientIndex({ ...config, apiKey: `${secret}\ninvalid` })).toThrow("QDRANT_UNAVAILABLE");
  });
  it("redacts server errors and never logs secrets", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = stub(); fetch.mockResolvedValueOnce(new Response(`upstream ${secret}`, { status: 500 }));
    await expect(new QdrantClientIndex(config).ensureCollection(spec)).rejects.toMatchObject({ message: "QDRANT_UNAVAILABLE" });
    expect(warn).not.toHaveBeenCalled();
  });
  it("uses authenticated requests with redirects refused and honors HTTPS default port/prefix", async () => {
    const fetch = stub(); await new QdrantClientIndex({ ...config, url: "https://q.example/proxy" }).ensureCollection(spec);
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/q.example\/proxy\/collections\//u);
      expect(init?.redirect).toBe("error"); expect(new Headers(init?.headers).get("api-key")).toBe(secret);
    }
  });
  it("times out real local HTTP requests with a sanitized error", async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const index = new QdrantClientIndex({ ...config, timeoutMs: 100, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    const start = performance.now();
    try {
      await expect(index.ensureCollection(spec)).rejects.toMatchObject({ message: "QDRANT_UNAVAILABLE" });
      expect(performance.now() - start).toBeLessThan(2000);
    } finally { index.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("close refuses subsequent calls", async () => {
    const fetch = stub(); const index = new QdrantClientIndex(config); index.close();
    await expect(index.ensureCollection(spec)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
});
