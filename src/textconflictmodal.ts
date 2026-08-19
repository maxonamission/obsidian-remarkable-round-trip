/**
 * Write-mode conflict choice (GP_E7_S3, F14/N5): the note changed in the
 * vault after it was sent AND the device copy was edited. Merging silently
 * is out of the question — the user picks which side wins, and either way
 * nothing is lost: replacing backs the note up first, keeping saves the
 * device text alongside.
 *
 * Follows the mobile modal pattern (codebase-standards,
 * obsidian-mobiel-patroon.md): no layout measuring at open, no inline
 * styles, no silently disabled buttons, everything tappable answers —
 * including dismissing the modal, which answers "cancel".
 */

import { App, Modal, Setting } from "obsidian";
import type { ConflictChoice } from "./sync/textimport";

export class TextConflictModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private readonly noteName: string,
		private readonly onChoose: (choice: ConflictChoice) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle(`"${this.noteName}" changed on both sides`);
		contentEl.createEl("p", {
			text:
				"This note was edited in your vault after it was sent, and the copy " +
				"on the reMarkable was edited too. Pick which version the note keeps — " +
				"the other one is saved, not thrown away.",
		});

		new Setting(contentEl)
			.setName("Use the reMarkable text")
			.setDesc("The current note is saved as a backup copy first.")
			.addButton((button) =>
				button
					.setButtonText("Replace note")
					.setCta()
					.onClick(() => this.choose("replace")),
			);

		new Setting(contentEl)
			.setName("Keep the note as it is")
			.setDesc("The reMarkable text is saved in a file next to the note.")
			.addButton((button) =>
				button.setButtonText("Keep note").onClick(() => this.choose("keep")),
			);

		new Setting(contentEl).addButton((button) =>
			button.setButtonText("Cancel").onClick(() => this.choose("cancel")),
		);
	}

	onClose(): void {
		// Dismissing the modal (Esc, tap outside) is an answer too.
		if (!this.answered) {
			this.answered = true;
			this.onChoose("cancel");
		}
	}

	private choose(choice: ConflictChoice): void {
		if (this.answered) return;
		this.answered = true;
		this.close();
		this.onChoose(choice);
	}
}
