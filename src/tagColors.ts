// Edit the board's tag colours, kept where obsidian-kanban keeps them (the
// board's settings block) as rgba() strings.

import { Modal, Setting, type App } from "obsidian";
import type { TagColor } from "./parser";
import { paintTag } from "./view";

type Rgb = { r: number; g: number; b: number };

function toRgb(s: string | undefined): Rgb {
  const m = s?.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  return m ? { r: +m[1], g: +m[2], b: +m[3] } : { r: 128, g: 128, b: 128 };
}

const toRgba = ({ r, g, b }: Rgb) => `rgba(${r}, ${g}, ${b}, 1)`;

export class TagColorsModal extends Modal {
  private colors: TagColor[];
  private onSave: (colors: TagColor[]) => void;
  private changed = false;

  constructor(app: App, colors: TagColor[], onSave: (colors: TagColor[]) => void) {
    super(app);
    this.colors = colors.map((t) => ({ ...t }));
    this.onSave = onSave;
  }

  onOpen() {
    this.titleEl.setText("Tag colours");
    this.draw();
  }

  onClose() {
    if (this.changed) this.onSave(this.colors.filter((t) => t.tagKey.length > 1));
  }

  private draw() {
    this.contentEl.empty();
    this.colors.forEach((tc, i) => {
      const row = new Setting(this.contentEl);
      const pill = row.nameEl.createEl("a", { cls: "tag kanban-plugin__item-tag" });
      const repaint = () => {
        pill.setText(tc.tagKey.length > 1 ? tc.tagKey : "#tag");
        paintTag(pill, tc);
      };
      const edit = (fn: () => void) => {
        fn();
        this.changed = true;
        repaint();
      };
      repaint();
      row.addText((t) =>
        t
          .setPlaceholder("#tag")
          .setValue(tc.tagKey)
          .onChange((v) => edit(() => (tc.tagKey = "#" + v.trim().replace(/^#/, "")))),
      );
      for (const key of ["color", "backgroundColor"] as const)
        row.addColorPicker((p) =>
          p.setValueRgb(toRgb(tc[key])).onChange(() => edit(() => (tc[key] = toRgba(p.getValueRgb())))),
        );
      row.addExtraButton((b) =>
        b
          .setIcon("lucide-trash-2")
          .setTooltip("Remove")
          .onClick(() => {
            this.colors.splice(i, 1);
            this.changed = true;
            this.draw();
          }),
      );
    });
    new Setting(this.contentEl).setDesc("Text colour, then background.").addButton((b) =>
      b.setButtonText("Add a tag").onClick(() => {
        this.colors.push({ tagKey: "#", color: "rgba(0, 0, 0, 1)", backgroundColor: "rgba(200, 200, 200, 1)" });
        this.draw();
      }),
    );
  }
}
