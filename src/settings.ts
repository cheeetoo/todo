import type { BoardSettings, TagColor } from "./parser";

/** The obsidian-kanban settings this plugin understands, resolved for one board. */
export interface Settings {
  "show-checkboxes": boolean;
  "hide-card-count": boolean;
  "move-tags": boolean;
  "tag-action": "kanban" | "obsidian";
  "tag-colors": TagColor[];
  "lane-width": number;
  "list-collapse": boolean[];
  "new-line-trigger": "enter" | "shift-enter";
  "new-card-insertion-method": "append" | "prepend" | "prepend-compact";
  "time-trigger": string;
  "date-trigger": string;
  "date-format": string;
}

/** obsidian-kanban's own defaults. */
export const DEFAULTS: Settings = {
  "show-checkboxes": false,
  "hide-card-count": false,
  "move-tags": false,
  "tag-action": "obsidian",
  "tag-colors": [],
  "lane-width": 272,
  "list-collapse": [],
  "new-line-trigger": "shift-enter",
  "new-card-insertion-method": "append",
  "time-trigger": "@@",
  "date-trigger": "@",
  "date-format": "YYYY-MM-DD",
};

/** Board settings win over global ones (the Kanban plugin's data.json), which win over defaults. */
export function resolveSettings(global: Partial<Settings>, board: BoardSettings): Settings {
  const out = { ...DEFAULTS } as Record<string, unknown>;
  for (const src of [global, board] as Record<string, unknown>[]) {
    for (const [k, v] of Object.entries(src)) if (v !== undefined && v !== null && k in DEFAULTS) out[k] = v;
  }
  return out as unknown as Settings;
}
