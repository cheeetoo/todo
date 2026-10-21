// Reads and writes the obsidian-kanban markdown format, byte for byte, so the
// same TODO.md works with that plugin, with this one, and with cal-sync.
//
//   ---\n\nkanban-plugin: board\n\n---\n\n      frontmatter (kept verbatim)
//   ## Lane\n\n**Complete**\n- [ ] card\n\n\n    one block per lane
//   ***\n\n## Archive\n\n- [x] card             archive (optional)
//   \n\n%% kanban:settings ... %%               settings (kept verbatim)

export interface Card {
  /** The checkbox character (" ", "x", "-", ...), or null for a plain "- " item. */
  check: string | null;
  /** The text after the checkbox on the first line. */
  title: string;
  /** Continuation lines exactly as written in the file (normally tab-indented). */
  rest: string[];
}

export interface Lane {
  title: string;
  /** Lane carries the "**Complete**" marker: cards moved here get ticked. */
  complete: boolean;
  cards: Card[];
}

export interface TagColor {
  tagKey: string;
  color?: string;
  backgroundColor?: string;
}

export interface BoardSettings {
  "tag-colors"?: TagColor[];
  "tag-sort"?: { tag: string }[];
  "show-checkboxes"?: boolean;
  [key: string]: unknown;
}

export interface Board {
  frontmatter: string;
  lanes: Lane[];
  /** null when the file has no archive section. */
  archive: Card[] | null;
  /** Everything from the settings comment onwards, verbatim. */
  settingsBlock: string;
  settings: BoardSettings;
}

const COMPLETE = "**Complete**";
const ARCHIVE_RULE = "***";
const SETTINGS_RE = /\n{0,2}%% kanban:settings\n```\n([\s\S]*?)\n```\n%%\s*$/;
const ITEM_RE = /^- (?:\[(.)\] ?)?(.*)$/;

export class BoardParseError extends Error {}

export function isBoardFile(frontmatter: Record<string, unknown> | undefined): boolean {
  return !!frontmatter && frontmatter["kanban-plugin"] != null;
}

export function parseBoard(md: string): Board {
  let body = md;

  let frontmatter = "";
  const fm = body.match(/^---\n[\s\S]*?\n---\n*/);
  if (fm) {
    frontmatter = fm[0];
    body = body.slice(fm[0].length);
  }

  let settingsBlock = "";
  let settings: BoardSettings = {};
  const sm = body.match(SETTINGS_RE);
  if (sm) {
    settingsBlock = body.slice(sm.index!);
    body = body.slice(0, sm.index!);
    try {
      settings = JSON.parse(sm[1]);
    } catch {
      throw new BoardParseError("The kanban:settings block is not valid JSON.");
    }
  }

  const lanes: Lane[] = [];
  let archive: Card[] | null = null;
  let afterRule = false;
  let lane: Lane | null = null;
  let cards: Card[] | null = null;
  let card: Card | null = null;

  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const where = `line ${i + 1 + frontmatter.split("\n").length - 1}`;

    if (line.startsWith("## ")) {
      const title = line.slice(3);
      card = null;
      if (afterRule) {
        if (archive) throw new BoardParseError(`Unexpected heading after the archive (${where}).`);
        archive = [];
        cards = archive;
        lane = null;
      } else {
        lane = { title, complete: false, cards: [] };
        lanes.push(lane);
        cards = lane.cards;
      }
      continue;
    }

    if (line === ARCHIVE_RULE) {
      afterRule = true;
      card = null;
      cards = null;
      lane = null;
      continue;
    }

    if (line.trim() === "") {
      card = null;
      continue;
    }

    if (line === COMPLETE && lane && lane.cards.length === 0) {
      lane.complete = true;
      continue;
    }

    const item = line.match(ITEM_RE);
    if (item && cards) {
      card = { check: item[1] ?? null, title: item[2], rest: [] };
      cards.push(card);
      continue;
    }

    if (card && /^\s/.test(line)) {
      card.rest.push(line);
      continue;
    }

    throw new BoardParseError(`Don't know how to read ${where}: "${line}"`);
  }

  return { frontmatter, lanes, archive, settingsBlock, settings };
}

export function cardToMd(card: Card): string {
  const head = card.check === null ? `- ${card.title}` : `- [${card.check}] ${card.title}`;
  return [head, ...card.rest].join("\n");
}

export function serializeBoard(board: Board): string {
  let out = board.frontmatter;
  for (const lane of board.lanes) {
    const lines = [`## ${lane.title}`, ""];
    if (lane.complete) lines.push(COMPLETE);
    for (const card of lane.cards) lines.push(cardToMd(card));
    lines.push("", "", "");
    out += lines.join("\n");
  }
  if (board.archive?.length) {
    out += [ARCHIVE_RULE, "", "## Archive", "", ...board.archive.map(cardToMd)].join("\n");
  }
  return out + board.settingsBlock;
}

/** Change board settings; the block is rewritten the way obsidian-kanban writes it. */
export function updateSettings(board: Board, patch: BoardSettings): void {
  board.settings = { ...board.settings, ...patch };
  board.settingsBlock = ["", "", "%% kanban:settings", "```", JSON.stringify(board.settings), "```", "%%"].join("\n");
}

// ---- Card text as the user edits it: continuation lines lose one tab. ----

export function cardText(card: Card): string {
  return [card.title, ...card.rest.map((l) => l.replace(/^\t/, ""))].join("\n");
}

export function setCardText(card: Card, text: string): void {
  const [title, ...rest] = text.replace(/\s+$/, "").split("\n");
  card.title = title;
  card.rest = rest.map((l) => "\t" + l);
}

export function newCard(text: string, done = false): Card {
  const card: Card = { check: done ? "x" : " ", title: "", rest: [] };
  setCardText(card, text);
  return card;
}

// ---- Pulling tags, times and dates out of a card for display. ----

const TAG_RE = /(^|\s)#([\p{L}\p{N}_\-/]+)/gu;

export interface CardDisplay {
  /** Markdown to render: tags pulled out, times/dates swapped for obsidian-kanban's spans. */
  markdown: string;
  tags: string[];
  times: string[];
  dates: string[];
}

const KB = "kanban-plugin__";

function normTime(t: string): string | null {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return m[1].padStart(2, "0") + ":" + m[2];
}

/** Mirrors obsidian-kanban's preprocessTitle with move-tags on and move-dates off. */
export function cardDisplay(card: Card, opts: { moveTags: boolean } = { moveTags: true }): CardDisplay {
  let md = cardText(card);
  const tags: string[] = [];
  const times: string[] = [];
  const dates: string[] = [];

  md = md.replace(TAG_RE, (m, pre, tag) => {
    if (/^\d+$/.test(tag)) return m;
    if (!tags.includes("#" + tag)) tags.push("#" + tag);
    return opts.moveTags ? pre : m;
  });
  md = md.replace(/(^|\s)@\{([^}]+)\}/g, (m, pre, d) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return m;
    dates.push(d);
    return `${pre}<span class="${KB}preview-date-wrapper ${KB}date"><span class="${KB}preview-date ${KB}item-metadata-date">${d}</span></span>`;
  });
  md = md.replace(/(^|\s)@@\{([^}]+)\}/g, (m, pre, t) => {
    const time = normTime(t);
    if (!time) return m;
    times.push(time);
    return `${pre}<span class="${KB}preview-time-wrapper ${KB}date"><span class="${KB}preview-time ${KB}item-metadata-time">${time}</span></span>`;
  });

  tags.sort((a, b) => a.localeCompare(b));
  return { markdown: md, tags, times, dates };
}

/** Replace, add (index === times.length) or remove (value null) the nth @@{time} on a card. */
export function setCardTime(card: Card, index: number, value: string | null): void {
  let text = cardText(card);
  let n = 0;
  let done = false;
  text = text.replace(/(^|\s)@@\{([^}]+)\}/g, (m, pre) => {
    if (n++ !== index) return m;
    done = true;
    return value === null ? "" : `${pre}@@{${value}}`;
  });
  if (!done && value !== null) {
    const [first, ...rest] = text.split("\n");
    text = [`${first.replace(/\s+$/, "")} @@{${value}}`, ...rest].join("\n");
  }
  if (value === null && n > 1) {
    // Removing one end of "@@{a} - @@{b}" leaves the separator dangling.
    text = text
      // "@@{a} - " with nothing after: drop the separator.
      .replace(/(@@\{[^}]+\})[ \t]+(?:-|–|to|until)(?=\s|$)(?![ \t]*@@\{)/g, "$1")
      // " - @@{b}" with no time before it: likewise.
      .replace(/(?<!\})([ \t]+)(?:-|–|to|until)[ \t]+(?=@@\{)/g, " ");
  }
  setCardText(card, text.replace(/[ \t]+$/gm, ""));
}

/** Set (or with null, remove) the card's @{date}; a card has at most one. */
export function setCardDate(card: Card, value: string | null): void {
  let text = cardText(card);
  let done = false;
  text = text.replace(/(^|\s)@\{([^}]+)\}/, (_m, pre) => {
    done = true;
    return value === null ? "" : `${pre}@{${value}}`;
  });
  if (!done && value !== null) {
    const [first, ...rest] = text.split("\n");
    text = [`${first.replace(/\s+$/, "")} @{${value}}`, ...rest].join("\n");
  }
  setCardText(card, value === null ? text.replace(/[ \t]+$/gm, "") : text);
}

/** Tick or untick the nth "- [ ]" checklist line inside a card's continuation. */
export function toggleSubtask(card: Card, n: number): boolean {
  let seen = 0;
  for (let i = 0; i < card.rest.length; i++) {
    const m = card.rest[i].match(/^(\s*- \[)(.)(\].*)$/);
    if (!m) continue;
    if (seen++ === n) {
      card.rest[i] = m[1] + (m[2] === " " ? "x" : " ") + m[3];
      return true;
    }
  }
  return false;
}
