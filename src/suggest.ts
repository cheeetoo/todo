// Autocomplete inside board card editors:
//   @@  → times, starting from the next quarter hour
//   @   → dates (today, tomorrow, the coming week, or a typed date)
//   #   → tags, the board's own (with their colours) first

import {
  EditorSuggest,
  moment,
  type App,
  type Editor,
  type EditorPosition,
  type EditorSuggestContext,
  type EditorSuggestTriggerInfo,
  type TFile,
} from "obsidian";
import { boardEditors } from "./editor";
import type { BoardView } from "./view";

const m = moment as any;

function boardViewOf(editor: Editor): BoardView | undefined {
  return boardEditors.get((editor as any).cm);
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace start..end (plus a stray closing brace) with text, then a space unless one follows. */
function insert(ctx: EditorSuggestContext, text: string) {
  const { editor, start } = ctx;
  let end = ctx.end;
  const line = editor.getLine(end.line);
  if (text.endsWith("}") && line[end.ch] === "}") end = { line: end.line, ch: end.ch + 1 };
  const after = line.slice(end.ch);
  const replacement = after.startsWith(" ") ? text : text + " ";
  editor.replaceRange(replacement, start, end);
  const ch = start.ch + text.length + 1;
  editor.setCursor({ line: start.line, ch: Math.min(ch, editor.getLine(start.line).length) });
}

function aux(el: HTMLElement, title: string, note: string, strong = false) {
  el.addClass("mod-complex");
  const content = el.createDiv("suggestion-content");
  content.createDiv({ cls: "suggestion-title" }).createEl(strong ? "strong" : "span", { text: title });
  if (note) el.createDiv("suggestion-aux").createSpan({ cls: "suggestion-flair tb-suggest-note", text: note });
}

// ---------------------------------------------------------------- times

export function quarterHours(now: any): string[] {
  const seconds = now.minute() * 60 + now.second();
  const start = now.clone().startOf("hour").add(Math.ceil(seconds / 900) * 15, "minutes");
  const out: string[] = [];
  for (let i = 0; i < 96; i++) out.push(start.clone().add(i * 15, "minutes").format("HH:mm"));
  return out;
}

/** Times matching what's been typed: "9" → 09:xx, "930" → 09:30, "21:1" → 21:15… */
export function filterTimes(times: string[], query: string): string[] {
  const q = query.replace(/[^\d:]/g, "");
  if (!q) return times;
  const digits = q.replace(":", "");
  const hits = times.filter((t) => {
    const d = t.replace(":", "");
    return t.startsWith(q) || t.startsWith("0" + q) || d.startsWith(digits) || d.startsWith("0" + digits);
  });
  // An exact time that isn't on a quarter hour still deserves an option.
  const exact = digits.length >= 3 ? digits.padStart(4, "0") : null;
  if (exact && +exact.slice(0, 2) < 24 && +exact.slice(2) < 60) {
    const t = exact.slice(0, 2) + ":" + exact.slice(2);
    // Four digits is a definite time; three ("213") more likely starts a quarter hour (21:30).
    if (!hits.includes(t)) digits.length === 4 ? hits.unshift(t) : hits.push(t);
  }
  return hits;
}

function untilText(now: any, time: string): string {
  const [h, mm] = time.split(":").map(Number);
  let at = now.clone().hour(h).minute(mm).second(0);
  if (at.isBefore(now)) at = at.add(1, "day");
  const mins = Math.round(at.diff(now, "minutes", true));
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rest = mins % 60;
  return `in ${hrs}h${rest ? ` ${rest}m` : ""}`;
}

export class TimeSuggest extends EditorSuggest<string> {
  constructor(app: App) {
    super(app);
    this.limit = 96;
  }

  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    const view = boardViewOf(editor);
    if (!view) return null;
    const trigger = view.settings["time-trigger"];
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    const match = before.match(new RegExp(`(?:^|\\s)(${escapeRe(trigger)}\\{?)([^}\\s]*)$`));
    if (!match) return null;
    return {
      start: { line: cursor.line, ch: cursor.ch - match[2].length - match[1].length },
      end: cursor,
      query: match[2],
    };
  }

  getSuggestions(ctx: EditorSuggestContext): string[] {
    return filterTimes(quarterHours(m()), ctx.query);
  }

  renderSuggestion(value: string, el: HTMLElement) {
    aux(el, value, untilText(m(), value), value.endsWith(":00"));
  }

  selectSuggestion(value: string) {
    const view = this.context && boardViewOf(this.context.editor);
    if (!this.context || !view) return;
    insert(this.context, `${view.settings["time-trigger"]}{${value}}`);
  }
}

// ---------------------------------------------------------------- dates

interface DateOption {
  label: string;
  date: string;
}

export function dateOptions(today: any, query: string, format: string): DateOption[] {
  const opts: DateOption[] = [
    { label: "Today", date: today.format(format) },
    { label: "Tomorrow", date: today.clone().add(1, "day").format(format) },
  ];
  for (let i = 2; i < 8; i++) {
    const d = today.clone().add(i, "day");
    opts.push({ label: d.format("dddd"), date: d.format(format) });
  }
  const q = query.trim().toLowerCase();
  if (!q) return opts;
  const hits = opts.filter((o) => o.label.toLowerCase().startsWith(q) || o.date.startsWith(q));
  const typed = m(query, [format, "YYYY-MM-DD", "MMM D", "MMMM D", "D MMM", "M/D"], true);
  if (typed.isValid()) {
    if (typed.isBefore(today, "day") && !/\d{4}/.test(query)) typed.add(1, "year");
    const date = typed.format(format);
    if (!hits.some((o) => o.date === date)) hits.unshift({ label: typed.format("ddd, MMM D"), date });
  }
  return hits;
}

export class DateSuggest extends EditorSuggest<DateOption> {
  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    const view = boardViewOf(editor);
    if (!view) return null;
    const trigger = view.settings["date-trigger"];
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    const match = before.match(new RegExp(`(?:^|\\s)(${escapeRe(trigger)}\\{?)([^}@]*)$`));
    // "@@" is the time trigger, not a date: the query can't contain "@".
    if (!match) return null;
    return {
      start: { line: cursor.line, ch: cursor.ch - match[2].length - match[1].length },
      end: cursor,
      query: match[2],
    };
  }

  getSuggestions(ctx: EditorSuggestContext): DateOption[] {
    const view = boardViewOf(ctx.editor);
    return dateOptions(m().startOf("day"), ctx.query, view?.settings["date-format"] ?? "YYYY-MM-DD");
  }

  renderSuggestion(o: DateOption, el: HTMLElement) {
    aux(el, o.label, m(o.date, "YYYY-MM-DD").format("ddd, MMM D"));
  }

  selectSuggestion(o: DateOption) {
    const view = this.context && boardViewOf(this.context.editor);
    if (!this.context || !view) return;
    insert(this.context, `${view.settings["date-trigger"]}{${o.date}}`);
  }
}

// ---------------------------------------------------------------- tags

interface TagOption {
  tag: string;
  count: number;
  onBoard: boolean;
}

export class TagSuggest extends EditorSuggest<TagOption> {
  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    if (!boardViewOf(editor)) return null;
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    const match = before.match(/(?:^|\s)#([\p{L}\p{N}_\-/]*)$/u);
    if (!match) return null;
    return { start: { line: cursor.line, ch: cursor.ch - match[1].length - 1 }, end: cursor, query: match[1] };
  }

  getSuggestions(ctx: EditorSuggestContext): TagOption[] {
    const view = boardViewOf(ctx.editor);
    if (!view) return [];
    const q = ctx.query.toLowerCase();
    const board = view.boardTags();
    const vault = (this.app.metadataCache as any).getTags?.() as Record<string, number> | undefined;

    const opts = new Map<string, TagOption>();
    for (const [tag, count] of board) opts.set(tag.toLowerCase(), { tag, count, onBoard: true });
    for (const [tag, count] of Object.entries(vault ?? {})) {
      if (!opts.has(tag.toLowerCase())) opts.set(tag.toLowerCase(), { tag, count, onBoard: false });
    }

    const score = (o: TagOption) => {
      const name = o.tag.slice(1).toLowerCase();
      if (!q) return 0;
      if (name.startsWith(q)) return 0;
      if (name.includes(q)) return 1;
      return -1;
    };
    return [...opts.values()]
      .filter((o) => score(o) >= 0 && o.tag.slice(1).toLowerCase() !== q)
      .sort((a, b) => score(a) - score(b) || +b.onBoard - +a.onBoard || b.count - a.count)
      .slice(0, 30);
  }

  renderSuggestion(o: TagOption, el: HTMLElement) {
    const view = this.context && boardViewOf(this.context.editor);
    el.addClass("mod-complex");
    const title = el.createDiv("suggestion-content").createDiv("suggestion-title");
    const pill = title.createEl("a", { cls: "tag kanban-plugin__item-tag tb-suggest-tag" });
    pill.createSpan({ text: "#" });
    pill.appendText(o.tag.slice(1));
    const color = view?.tagColor(o.tag);
    if (color?.color) pill.style.setProperty("--tag-color", color.color);
    if (color?.backgroundColor) pill.style.setProperty("--tag-background", color.backgroundColor);
    el.createDiv("suggestion-aux").createSpan({ cls: "suggestion-flair tb-suggest-note", text: String(o.count) });
  }

  selectSuggestion(o: TagOption) {
    if (this.context) insert(this.context, o.tag);
  }
}
