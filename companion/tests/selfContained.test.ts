import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    if (entry.isDirectory() && ["node_modules", "dist", "coverage"].includes(entry.name)) return [];
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat();
}

describe("self-contained deployment boundary", () => {
  it("has no TypeScript import that escapes companion", async () => {
    const root = resolve(import.meta.dirname, "..");
    const files = await typescriptFiles(root);
    const violations: string[] = [];
    const pattern = /(?:from\s+|import\s*\()\s*["'](\.\.?\/[^"']+)["']/gu;
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (!specifier) continue;
        const target = resolve(dirname(file), specifier);
        if (relative(root, target).startsWith("..")) violations.push(`${relative(root, file)} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("has no package dependency on a parent path", async () => {
    const root = resolve(import.meta.dirname, "..");
    for (const filename of ["package.json", "package-lock.json"]) {
      expect(await readFile(resolve(root, filename), "utf8")).not.toMatch(/(?:file:|link:)\.\.\//u);
    }
  });
});
