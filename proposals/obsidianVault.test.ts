import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ TFile: class { path = "A.md"; } }));
vi.mock("obsidian", () => mocks);
import { ObsidianProposalVault } from "./obsidianVault";
import { ProposalConflict } from "./application";
function fixture() {
  const file = new mocks.TFile(); let content = "base"; let exists = true;
  const vault = { configDir: ".custom", getAbstractFileByPath: vi.fn(() => exists ? file : null), read: vi.fn(async () => content),
    create: vi.fn(async () => { exists = true; }), process: vi.fn(async (_file: unknown, transform: (value: string) => string) => { content = transform(content); }) };
  const fileManager = { trashFile: vi.fn(async () => { exists = false; }) };
  const adapter = new ObsidianProposalVault({ vault, fileManager } as never);
  return { adapter, vault, fileManager, file, content: (): string => content, setExists: (value: boolean): void => { exists = value; } };
}
it("UPDATE checks the freshest content inside vault.process and preserves it on conflict", async () => {
  const f = fixture(); const transform = vi.fn((): string => { throw new ProposalConflict(); });
  await expect(f.adapter.update("A.md", transform)).rejects.toBeInstanceOf(ProposalConflict);
  expect(transform).toHaveBeenCalledWith("base"); expect(f.content()).toBe("base"); expect(f.vault.process).toHaveBeenCalledOnce();
});
it("a renamed file cannot be overwritten through a stale TFile", async () => {
  const f = fixture(); f.file.path = "renamed.md";
  await expect(f.adapter.update("A.md", () => "new")).rejects.toBeInstanceOf(ProposalConflict); expect(f.content()).toBe("base");
});
it("CREATE checks absence and the lease before vault.create", async () => {
  const f = fixture(); await expect(f.adapter.create("A.md", "new", () => {})).rejects.toBeInstanceOf(ProposalConflict);
  expect(f.vault.create).not.toHaveBeenCalled(); f.setExists(false);
  await expect(f.adapter.create("A.md", "new", () => { throw new Error("expired"); })).rejects.toThrow("expired"); expect(f.vault.create).not.toHaveBeenCalled();
  await f.adapter.create("A.md", "new", () => {}); expect(f.vault.create).toHaveBeenCalledExactlyOnceWith("A.md", "new");
});
it("DELETE checks current content before the established Obsidian trash wrapper", async () => {
  const f = fixture(); await expect(f.adapter.remove("A.md", () => { throw new ProposalConflict(); })).rejects.toBeInstanceOf(ProposalConflict);
  expect(f.fileManager.trashFile).not.toHaveBeenCalled(); const check = vi.fn(); await f.adapter.remove("A.md", check);
  expect(check).toHaveBeenCalledWith("base"); expect(f.fileManager.trashFile).toHaveBeenCalledExactlyOnceWith(f.file); expect(await f.adapter.read("A.md")).toBeNull();
});
it("proposal application has no filesystem, shell, direct mirror sync or embedding dependency", () => {
  for (const name of ["application.ts", "obsidianVault.ts", "reviewModal.ts"]) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8");
    expect(source).not.toMatch(/node:|writeFile|unlink|child_process|applyBatch|syncBatch|embedQuery|embedDocuments/u);
  }
});
