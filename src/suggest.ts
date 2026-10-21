// Autocomplete in card editors:
//   @@  times, starting from the next quarter hour
//   @   dates: today, tomorrow, the coming week, or one typed out
//   #   tags, the board's own (in their colours) first

import { EditorSuggest, moment, type Editor, type EditorPosition, type EditorSuggestContext } from "obsidian";
import { boardEditors } from "./editor";
import { DATE_FORMAT, paintTag, type BoardView } from "./view";

/** Suggestions for the token before the cursor; `pattern`'s group 1 is the token, group 2 the query. */
abstract class CardSuggest<T> extends EditorSuggest<T> {
  abstract pattern: RegExp;

  protected view(): BoardView | undefined {
    return this.context ? boardEditors.get((this.context.editor as any).cm) : undefined;
  }

  onTrigger(cursor: EditorPosition, editor: Editor) {
    if (!boardEditors.has((editor as any).cm)) return null;
    const m = editor.getLine(cursor.line).slice(0, cursor.ch).match(this.pattern);
    if (!m) return null;
    return { start: { line: cursor.line, ch: cursor.ch - m[1].length }, end: cursor, query: m[2] };
  }

  /** Replace the token (and a closing brace already there) with `text`, then a space unless one follows. */
  protected insert(text: string) {
    const { editor, start } = this.context!;
    let { end } = this.context!;
    const line = editor.getLine(end.line);
    if (text.endsWith("}") && line[end.ch] === "}") end = { line: end.line, ch: end.ch + 1 };
    editor.replaceRange(line[end.ch] === " " ? text : text + " ", start, end);
    editor.setCursor({ line: start.line, ch: Math.min(start.ch + text.length + 1, editor.getLine(start.line).length) });
  }
}

function row(el: HTMLElement, title: string, note: string, strong = false) {
  el.addClass("mod-complex");
  el.createDiv("suggestion-content").createDiv("suggestion-title").createEl(strong ? "strong" : "span", { text: title });
  el.createDiv("suggestion-aux").createSpan({ cls: "suggestion-flair tb-suggest-note", text: note });
}

// ---------------------------------------------------------------- times

/** Every quarter hour for the next day, starting with the next one. */
export function quarterHours(now: moment.Moment): string[] {
  const first = now.clone().startOf("hour").add(Math.ceil((now.minute() * 60 + now.second()) / 900) * 15, "minutes");
  return Array.from({ length: 96 }, (_, i) => first.clone().add(i * 15, "minutes").format("HH:mm"));
}

/** Times matching what's been typed: "9" → 09:xx, "930" → 09:30, "213" → 21:30… */
export function filterTimes(times: string[], query: string): string[] {
  const digits = query.replace(/\D/g, "");
  if (!digits) return times;
  const hits = times.filter((t) => t.replace(":", "").startsWith(digits) || t.replace(":", "").startsWith("0" + digits));
  // A time off the quarter hours still gets an option: first if it's four digits,
  // last if three ("213" more likely means 21:30 than 02:13).
  const exact = digits.length >= 3 ? digits.padStart(4, "0") : "";
  if (exact && +exact.slice(0, 2) < 24 && +exact.slice(2) < 60) {
    const t = `${exact.slice(0, 2)}:${exact.slice(2)}`;
    if (!hits.includes(t)) digits.length === 4 ? hits.unshift(t) : hits.push(t);
  }
  return hits;
}

function fromNow(time: string): string {
  const now = moment();
  const at = moment(time, "HH:mm");
  if (at.isBefore(now)) at.add(1, "day");
  const mins = Math.round(at.diff(now, "minutes", true));
  return mins < 60 ? `in ${mins}m` : `in ${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}`;
}

export class TimeSuggest extends CardSuggest<string> {
  pattern = /(?:^|\s)(@@\{?([^}\s]*))$/;
  limit = 96;

  getSuggestions(ctx: EditorSuggestContext) {
    return filterTimes(quarterHours(moment()), ctx.query);
  }

  renderSuggestion(time: string, el: HTMLElement) {
    row(el, time, fromNow(time), time.endsWith(":00"));
  }

  selectSuggestion(time: string) {
    this.insert(`@@{${time}}`);
  }
}

// ---------------------------------------------------------------- dates

interface DateOption {
  label: string;
  date: string;
}

export function dateOptions(today: moment.Moment, query: string): DateOption[] {
  const week = Array.from({ length: 8 }, (_, i) => {
    const d = today.clone().add(i, "days");
    return { label: i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.format("dddd"), date: d.format(DATE_FORMAT) };
  });
  const q = query.trim().toLowerCase();
  if (!q) return week;
  const hits = week.filter((o) => o.label.toLowerCase().startsWith(q) || o.date.startsWith(q));
  const typed = moment(query, [DATE_FORMAT, "MMM D", "MMMM D", "D MMM", "M/D"], true);
  if (typed.isValid()) {
    // "Mar 3" means the next one.
    if (typed.isBefore(today, "day") && !/\d{4}/.test(query)) typed.add(1, "year");
    const date = typed.format(DATE_FORMAT);
    if (!hits.some((o) => o.date === date)) hits.unshift({ label: typed.format("ddd, MMM D"), date });
  }
  return hits;
}

export class DateSuggest extends CardSuggest<DateOption> {
  // No "@" in the query, so "@@" (a time) never reads as a date.
  pattern = /(?:^|\s)(@\{?([^}@]*))$/;

  getSuggestions(ctx: EditorSuggestContext) {
    return dateOptions(moment().startOf("day"), ctx.query);
  }

  renderSuggestion(o: DateOption, el: HTMLElement) {
    row(el, o.label, moment(o.date, DATE_FORMAT).format("ddd, MMM D"));
  }

  selectSuggestion(o: DateOption) {
    this.insert(`@{${o.date}}`);
  }
}

// ---------------------------------------------------------------- tags

interface TagOption {
  tag: string;
  count: number;
  onBoard: boolean;
}

export class TagSuggest extends CardSuggest<TagOption> {
  pattern = /(?:^|\s)(#([\p{L}\p{N}_\-/]*))$/u;

  getSuggestions(ctx: EditorSuggestContext) {
    const view = this.view();
    if (!view) return [];
    const q = ctx.query.toLowerCase();
    const opts = new Map<string, TagOption>();
    for (const [tag, count] of view.boardTags()) opts.set(tag.toLowerCase(), { tag, count, onBoard: true });
    const vault: Record<string, number> = (this.app.metadataCache as any).getTags?.() ?? {};
    for (const [tag, count] of Object.entries(vault))
      if (!opts.has(tag.toLowerCase())) opts.set(tag.toLowerCase(), { tag, count, onBoard: false });

    // Prefix matches, then substring matches; board tags first, then by use.
    const rank = (o: TagOption) => (o.tag.slice(1).toLowerCase().startsWith(q) ? 0 : 1);
    return [...opts.values()]
      .filter((o) => o.tag.slice(1).toLowerCase().includes(q) && o.tag.slice(1).toLowerCase() !== q)
      .sort((a, b) => rank(a) - rank(b) || +b.onBoard - +a.onBoard || b.count - a.count)
      .slice(0, 30);
  }

  renderSuggestion(o: TagOption, el: HTMLElement) {
    el.addClass("mod-complex");
    const pill = el
      .createDiv("suggestion-content")
      .createDiv("suggestion-title")
      .createEl("a", { cls: "tag kanban-plugin__item-tag tb-suggest-tag", text: o.tag });
    paintTag(pill, this.view()?.tagColor(o.tag));
    el.createDiv("suggestion-aux").createSpan({ cls: "suggestion-flair tb-suggest-note", text: String(o.count) });
  }

  selectSuggestion(o: TagOption) {
    this.insert(o.tag);
  }
}
