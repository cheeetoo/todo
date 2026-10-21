// What the calendar should hold for a board: cards with times or dates become
// events. A port of ~/fun/cal (todocal); the rules, in brief:
//
// - A card's time is a deadline. A card runs from the previous card's deadline
//   to its own; the first runs from now. Never from before now, nor from before
//   the start of the day it ends in.
// - A deadline that has gone by rolls to the next day at the same clock time,
//   unless the card is ticked or names its own @{date}.
// - Two times (@@{22:00} - @@{22:30}) pin a card to exactly that span. Pins sit
//   outside the chain, but a chained card waits for a pin that ends before its
//   deadline.
// - A date and no time is an all-day event.
// - The day rolls over at 04:00, so 00:30 belongs to the night before.

import type { Board } from "../parser";

const DAY_START_HOUR = 4;
const MIN_MINUTES = 15;
const SKIP_LANES = ["done", "archive", "complete"];
const DONE_PREFIX = "✓ ";
/** Marks events this sync owns; nothing without it is ever touched. */
export const MARKER = "todoSync";

export interface Task {
  title: string;
  /** The card's first line as written (the event title when nothing else is left). */
  raw: string;
  tags: string[];
  done: boolean;
  notes: string;
  lane: string;
  order: number;
  /** Minutes after midnight. `at` is the deadline; `atStart` makes it a pinned span. */
  at: number | null;
  atStart: number | null;
  /** YYYY-MM-DD */
  on: string | null;
}

export interface Block {
  task: Task;
  start: Date;
  end: Date;
  allDay: boolean;
}

export interface EventBody {
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string } | { date: string };
  end: { dateTime: string; timeZone: string } | { date: string };
  reminders: { useDefault: false; overrides: [] };
  extendedProperties: { private: Record<string, string> };
}

// ---------------------------------------------------------------- reading cards

const TOKEN = String.raw`@@(?:\{[^}]+\}|\[\[[^\]]+\]\])`;
const TIME_RE = /@@(?:\{([^}]+)\}|\[\[([^\]]+)\]\])/g;
const RANGE_RE = new RegExp(String.raw`(${TOKEN})\s*(?:[-–—>]+|to|until|till)?\s*(${TOKEN})`, "gi");
const DATE_RE = /(?<!@)@(?:\{([^}]+)\}|\[\[([^\]]+)\]\])/g;
const TAG_RE = /(?:^|\s)#([^\s#]+)/g;

/** "22:30", "9:05", "9pm", "10:15 PM" → minutes after midnight. */
export function parseClock(text: string): number | null {
  const m = text.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
  if (!m) return null;
  let hour = +m[1];
  const minute = +(m[2] ?? 0);
  const ampm = (m[3] ?? "").replace(/\./g, "").toLowerCase();
  if (ampm) {
    if (hour < 1 || hour > 12 || minute > 59) return null;
    hour = ampm === "am" ? hour % 12 : (hour % 12) + 12;
  } else if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function parseIsoDate(text: string): string | null {
  const m = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 ? m[0] : null;
}

const clockIn = (token: string) => {
  const m = token.match(/^@@(?:\{([^}]+)\}|\[\[([^\]]+)\]\])$/);
  return m ? parseClock(m[1] ?? m[2]) : null;
};

/** One card's text → its title, tags, times and date. */
export function readCard(body: string): Pick<Task, "title" | "tags" | "at" | "atStart" | "on"> {
  let at: number | null = null;
  let atStart: number | null = null;
  let on: string | null = null;
  const tags: string[] = [];

  let text = body.replace(RANGE_RE, (m, first, second) => {
    const [a, b] = [clockIn(first), clockIn(second)];
    if (a === null || b === null) return m;
    [atStart, at] = [a, b];
    return " ";
  });
  text = text.replace(TIME_RE, (m, a, b) => {
    const clock = parseClock(a ?? b);
    if (clock === null) return m;
    at = clock;
    return " ";
  });
  text = text.replace(DATE_RE, (m, a, b) => {
    const date = parseIsoDate(a ?? b);
    if (!date) return m;
    on = date;
    return " ";
  });
  text = text.replace(TAG_RE, (_m, raw: string) => {
    const tag = raw.replace(/[.,;:!?]+$/, "");
    if (tag && !tags.includes(tag)) tags.push(tag);
    return " ";
  });
  const title = text.replace(/\s+/g, " ").replace(/^[ \-–—]+|[ \-–—]+$/g, "");
  return { title, tags, at, atStart, on };
}

/** Cards from every lane except Done/Complete (the archive is never read). */
function tasksOf(board: Board): Task[] {
  const tasks: Task[] = [];
  for (const lane of board.lanes) {
    if (SKIP_LANES.includes(lane.title.trim().toLowerCase())) continue;
    for (const card of lane.cards) {
      if (card.check === null || !" xX".includes(card.check) || !card.title.trim()) continue;
      tasks.push({
        ...readCard(card.title),
        raw: card.title.trim(),
        done: card.check !== " ",
        notes: card.rest.map((l) => l.trim()).filter(Boolean).join("\n"),
        lane: lane.title,
        order: tasks.length,
      });
    }
  }
  return tasks;
}

// ---------------------------------------------------------------- dates

const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function at(day: string, minutes: number): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
}

/** Whole days later, keeping the clock time across DST. */
function shiftDays(when: Date, days: number): Date {
  const d = new Date(when);
  d.setDate(d.getDate() + days);
  return d;
}

const addDays = (day: string, n: number) => dayOf(shiftDays(at(day, 0), n));

/** The date the board's "Today" means: before 04:00 it's still yesterday. */
function logicalToday(now: Date): string {
  return dayOf(now.getHours() < DAY_START_HOUR ? shiftDays(now, -1) : now);
}

/** When the logical day containing `when` began. */
const dayFloor = (when: Date) => at(logicalToday(when), DAY_START_HOUR * 60);

/** Which date one clock reading on a card falls on. */
function dayFor(clock: number, task: Task, today: string): string {
  if (task.on) return task.on;
  return clock < DAY_START_HOUR * 60 ? addDays(today, 1) : today;
}

/** A missed deadline moves on whole days; a span still running stays. */
function rollForward(start: Date, end: Date, now: Date): [Date, Date] {
  let days = 0;
  while (shiftDays(end, days) < now) days++;
  return [shiftDays(start, days), shiftDays(end, days)];
}

const rolls = (task: Task) => task.on === null && !task.done;

/** ISO 8601 with the local offset, as Google expects. */
function isoLocal(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${dayOf(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

// ---------------------------------------------------------------- blocks

function buildBlocks(tasks: Task[], now: Date): Block[] {
  const today = logicalToday(now);
  const blocks: Block[] = [];
  const chained: [Date, Task][] = [];
  const pinEnds: Date[] = [];

  for (const task of tasks) {
    if (task.at === null) {
      if (task.on) {
        const start = at(task.on, 0);
        blocks.push({ task, start, end: shiftDays(start, 1), allDay: true });
      }
      continue;
    }
    if (task.atStart !== null) {
      let start = at(dayFor(task.atStart, task, today), task.atStart);
      let end = at(dayFor(task.at, task, today), task.at);
      if (end < start) end = shiftDays(end, 1); // 23:00 → 05:00 runs overnight
      if (rolls(task)) [start, end] = rollForward(start, end, now);
      blocks.push({ task, start, end, allDay: false });
      if (end > start) pinEnds.push(end); // a zero-length moment has nothing to wait out
      continue;
    }
    let end = at(dayFor(task.at, task, today), task.at);
    if (rolls(task)) end = rollForward(end, end, now)[1];
    chained.push([end, task]);
  }
  chained.sort(([a, s], [b, t]) => +a - +b || s.order - t.order);

  let cursor = now;
  for (const [end, task] of chained) {
    let start = new Date(Math.max(+cursor, +now, +dayFloor(end)));
    // Wait for any pinned card that finishes before this deadline.
    for (const p of pinEnds) if (p < end && p > start) start = p;
    // Two cards share a time, or a dated card sits in the past.
    if (start >= end) start = new Date(+end - MIN_MINUTES * 60_000);
    blocks.push({ task, start, end, allDay: false });
    cursor = end;
  }

  return blocks.sort((a, b) => +a.start - +b.start || +a.end - +b.end || a.task.order - b.task.order);
}

const blockDay = (b: Block) => dayOf(b.allDay ? b.start : b.end);

/** Stable identity: the day plus the card text (as todocal computed it, so events carry over). */
const blockKey = (b: Block) => sha1(`${blockDay(b)}|${b.allDay ? "all-day|" : ""}${b.task.title.toLowerCase()}`);

// ---------------------------------------------------------------- events

function eventBody(b: Block, fileName: string, timeZone: string, key: string): EventBody {
  const { task } = b;
  let summary = task.title || task.raw || "(untitled)";
  if (task.tags.length) summary = `[${task.tags.join("/")}] ${summary}`;
  if (task.done) summary = DONE_PREFIX + summary;
  const edge = (d: Date) => (b.allDay ? { date: dayOf(d) } : { dateTime: isoLocal(d), timeZone });
  return {
    summary,
    description: [task.notes, `From ${fileName} · ${task.lane || "board"}`].filter(Boolean).join("\n\n"),
    start: edge(b.start),
    end: edge(b.end),
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { [MARKER]: "1", todoKey: key, todoDay: blockDay(b) } },
  };
}

/** The events the calendar should hold, by key, plus the span they cover. */
export function plan(board: Board, now: Date, fileName: string, timeZone: string) {
  const blocks = buildBlocks(tasksOf(board), now);
  const events = new Map<string, EventBody>();
  for (const b of blocks) {
    // Two identical cards on one day would share a key; number the repeats.
    const base = blockKey(b);
    let key = base;
    for (let n = 1; events.has(key); n++) key = base.slice(0, -2) + n.toString(16).padStart(2, "0");
    events.set(key, eventBody(b, fileName, timeZone, key));
  }

  // Reconcile from the start of today (past days stay as a record) to 90 days
  // out, so dated cards stay reachable once removed from the board.
  let from = dayFloor(now);
  let to = shiftDays(from, 90);
  for (const b of blocks) {
    if (b.start < from) from = b.start;
    if (b.end > to) to = b.end;
  }
  return { events, from: new Date(+from - 3_600_000), to: new Date(+to + 3_600_000) };
}

// ---------------------------------------------------------------- sha1

/** SHA-1 hex of a string's UTF-8 bytes (synchronous; crypto.subtle isn't). */
export function sha1(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const words = new Uint32Array((((bytes.length + 8) >> 6) + 1) * 16);
  bytes.forEach((b, i) => (words[i >> 2] |= b << (24 - (i % 4) * 8)));
  words[bytes.length >> 2] |= 0x80 << (24 - (bytes.length % 4) * 8);
  words[words.length - 1] = bytes.length * 8;

  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  for (let i = 0; i < words.length; i += 16) {
    for (let t = 0; t < 80; t++) w[t] = t < 16 ? words[i + t] : rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    let [a, b, c, d, e] = h;
    for (let t = 0; t < 80; t++) {
      const [f, k] =
        t < 20 ? [(b & c) | (~b & d), 0x5a827999]
        : t < 40 ? [b ^ c ^ d, 0x6ed9eba1]
        : t < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
        : [b ^ c ^ d, 0xca62c1d6];
      const tmp = (rotl(a, 5) + f + e + k + w[t]) >>> 0;
      [e, d, c, b, a] = [d, c, rotl(b, 30) >>> 0, a, tmp];
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, "0")).join("");
}
