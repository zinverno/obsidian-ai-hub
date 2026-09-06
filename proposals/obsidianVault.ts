import { TFile } from "obsidian";
import type { App, Vault } from "obsidian";
import { ProposalConflict } from "./application";
import type { ProposalVault } from "./application";

export class ObsidianProposalVault implements ProposalVault {
  private readonly vault: Vault;
  constructor(private readonly app: App) { this.vault = app.vault; }
  get configDir(): string { return this.vault.configDir; }
  private file(path: string): TFile {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new ProposalConflict();
    return file;
  }
  async read(path: string): Promise<string | null> {
    if (!this.vault.getAbstractFileByPath(path)) return null;
    return this.vault.read(this.file(path));
  }
  async create(path: string, content: string, guard: () => void): Promise<void> {
    guard();
    if (this.vault.getAbstractFileByPath(path)) throw new ProposalConflict();
    await this.vault.create(path, content);
  }
  async update(path: string, transform: (current: string) => string): Promise<void> {
    const file = this.file(path);
    await this.vault.process(file, (current) => {
      if (file.path !== path || this.vault.getAbstractFileByPath(path) !== file) throw new ProposalConflict();
      return transform(current);
    });
  }
  async remove(path: string, check: (current: string) => void): Promise<void> {
    const file = this.file(path);
    const current = await this.vault.read(file);
    if (file.path !== path || this.vault.getAbstractFileByPath(path) !== file) throw new ProposalConflict();
    check(current);
    await this.app.fileManager.trashFile(file);
  }
}
