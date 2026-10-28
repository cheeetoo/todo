// The board's keyboard shortcuts, as the "?" cheat sheet lists them.

import { Modal } from "obsidian";

export const KEY_HELP: [keys: string, does: string][] = [
  ["j  k", "Next / previous card (↓ ↑ work too)"],
  ["h  l", "Previous / next list (← → work too)"],
  ["g g  G", "First / last card in the list"],
  ["Shift + j  k", "Move the card down / up in its list"],
  ["Shift + h  l", "Move the card to the previous / next list"],
  ["Enter  e", "Edit the card"],
  ["a", "Add a card to the list"],
  ["d d", "Delete the card"],
  ["u", "Undo"],
  ["/", "Search (Enter then jumps to the first match)"],
  ["Esc", "Drop the selection"],
  ["?", "This list"],
];

export class KeysModal extends Modal {
  onOpen() {
    this.titleEl.setText("Board keys");
    const table = this.contentEl.createEl("table", { cls: "tb-keys-table" });
    for (const [keys, does] of KEY_HELP) {
      const row = table.createEl("tr");
      const cell = row.createEl("td");
      keys.split("  ").forEach((group, i) => {
        if (i) cell.appendText("  ");
        for (const [j, key] of group.split(" + ").entries()) {
          if (j) cell.appendText(" + ");
          cell.createEl("kbd", { text: key });
        }
      });
      row.createEl("td", { text: does });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
