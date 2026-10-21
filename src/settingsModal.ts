// Board settings: the obsidian-kanban settings this board uses, saved in the
// board's own settings block exactly where obsidian-kanban keeps them.

import { Modal, Setting, type App } from "obsidian";
import type { BoardSettings, TagColor } from "./parser";
import type { Settings } from "./settings";

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseRgba(s: string | undefined): { rgb: Rgb; a: number } | null {
  const m = s?.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/);
  if (m) return { rgb: { r: +m[1], g: +m[2], b: +m[3] }, a: m[4] === undefined ? 1 : +m[4] };
  const h = s?.match(/^#([0-9a-f]{6})$/i);
  if (h) {
    const n = parseInt(h[1], 16);
    return { rgb: { r: n >> 16, g: (n >> 8) & 255, b: n & 255 }, a: 1 };
  }
  return null;
}

const rgba = ({ r, g, b }: Rgb, a: number) => `rgba(${r}, ${g}, ${b}, ${a})`;

export class BoardSettingsModal extends Modal {
  private settings: Settings;
  private onSave: (patch: BoardSettings) => void;
  private patch: BoardSettings = {};
  private tagColors: TagColor[];

  constructor(app: App, resolved: Settings, onSave: (patch: BoardSettings) => void) {
    super(app);
    this.settings = resolved;
    this.onSave = onSave;
    this.tagColors = resolved["tag-colors"].map((t) => ({ ...t }));
  }

  onOpen() {
    this.titleEl.setText("Board settings");
    this.draw();
  }

  onClose() {
    if (Object.keys(this.patch).length) this.onSave(this.patch);
  }

  private set<K extends keyof Settings>(key: K, value: Settings[K]) {
    (this.patch as Record<string, unknown>)[key] = value;
  }

  private draw() {
    const el = this.contentEl;
    el.empty();
    const s = this.settings;

    new Setting(el)
      .setName("Show checkboxes")
      .setDesc("Show a checkbox on each card.")
      .addToggle((t) => t.setValue(s["show-checkboxes"]).onChange((v) => this.set("show-checkboxes", v)));
    new Setting(el)
      .setName("Hide card counts in list titles")
      .addToggle((t) => t.setValue(s["hide-card-count"]).onChange((v) => this.set("hide-card-count", v)));
    new Setting(el)
      .setName("Move tags to card footer")
      .setDesc("Show a card's tags under its text instead of inline.")
      .addToggle((t) => t.setValue(s["move-tags"]).onChange((v) => this.set("move-tags", v)));
    new Setting(el)
      .setName("Clicking a tag")
      .addDropdown((d) =>
        d
          .addOption("kanban", "Searches this board")
          .addOption("obsidian", "Opens Obsidian's search")
          .setValue(s["tag-action"])
          .onChange((v) => this.set("tag-action", v as Settings["tag-action"])),
      );
    new Setting(el)
      .setName("List width")
      .setDesc("In pixels. obsidian-kanban's default is 272.")
      .addText((t) =>
        t.setValue(String(s["lane-width"])).onChange((v) => {
          const n = parseInt(v, 10);
          if (n >= 100 && n <= 1000) this.set("lane-width", n);
        }),
      );

    new Setting(el).setName("Tag colours").setHeading();
    const list = el.createDiv("tb-tag-colors");
    this.tagColors.forEach((tc, i) => this.drawTagColor(list, tc, i));
    new Setting(el).addButton((b) =>
      b.setButtonText("Add tag colour").onClick(() => {
        this.tagColors.push({ tagKey: "#", color: "rgba(0, 0, 0, 1)", backgroundColor: "rgba(200, 200, 200, 1)" });
        this.saveTagColors();
        this.draw();
      }),
    );
  }

  private drawTagColor(list: HTMLElement, tc: TagColor, i: number) {
    const row = new Setting(list);
    const preview = row.nameEl.createEl("a", { cls: "tag kanban-plugin__item-tag" });
    const paint = () => {
      preview.empty();
      preview.createSpan({ text: "#" });
      preview.appendText(tc.tagKey.replace(/^#/, "") || "tag");
      if (tc.color) preview.style.setProperty("--tag-color", tc.color);
      if (tc.backgroundColor) preview.style.setProperty("--tag-background", tc.backgroundColor);
    };
    paint();

    row.addText((t) =>
      t
        .setPlaceholder("#tag")
        .setValue(tc.tagKey)
        .onChange((v) => {
          tc.tagKey = v.startsWith("#") ? v.trim() : "#" + v.trim();
          paint();
          this.saveTagColors();
        }),
    );
    for (const key of ["color", "backgroundColor"] as const) {
      row.addColorPicker((p) => {
        const cur = parseRgba(tc[key]);
        if (cur) p.setValueRgb(cur.rgb);
        p.onChange(() => {
          tc[key] = rgba(p.getValueRgb(), cur?.a ?? 1);
          paint();
          this.saveTagColors();
        });
      });
    }
    row.controlEl.lastElementChild?.setAttr("aria-label", "Background");
    row.addExtraButton((b) =>
      b
        .setIcon("lucide-trash-2")
        .setTooltip("Remove")
        .onClick(() => {
          this.tagColors.splice(i, 1);
          this.saveTagColors();
          this.draw();
        }),
    );
  }

  private saveTagColors() {
    this.patch["tag-colors"] = this.tagColors.filter((t) => t.tagKey.length > 1).map((t) => ({ ...t }));
  }
}
