import { App, ButtonComponent, Modal } from "obsidian";
import { t as tr } from "../i18n";

export interface SemanticConfirmation {
  title: string;
  paragraphs: readonly string[];
  confirmText: string;
  warning?: string;
  danger?: boolean;
}

export class SemanticConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly confirmation: SemanticConfirmation,
    private readonly resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.confirmation.title);
    this.contentEl.empty();
    for (const paragraph of this.confirmation.paragraphs) {
      this.contentEl.createEl("p", { text: paragraph });
    }
    if (this.confirmation.warning) {
      this.contentEl.createDiv({
        cls: "ai-hub-warning",
        text: this.confirmation.warning,
      });
    }
    const buttons = this.contentEl.createDiv({
      cls: "modal-button-container",
    });
    new ButtonComponent(buttons)
      .setButtonText(tr("Отмена"))
      .onClick(() => this.finish(false));
    const confirmButton = new ButtonComponent(buttons)
      .setButtonText(this.confirmation.confirmText)
      .onClick(() => this.finish(true));
    if (this.confirmation.danger) confirmButton.setWarning();
    else confirmButton.setCta();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolve(false);
    }
  }

  private finish(value: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(value);
    this.close();
  }
}

export function confirmSemanticOperation(
  app: App,
  confirmation: SemanticConfirmation,
): Promise<boolean> {
  return new Promise((resolve) => {
    new SemanticConfirmModal(app, confirmation, resolve).open();
  });
}
