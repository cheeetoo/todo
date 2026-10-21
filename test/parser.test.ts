import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseBoard, serializeBoard, cardDisplay, cardText, setCardText, setCardTime, setCardDate, newCard, toggleSubtask, updateSettings,
  BoardParseError,
} from "../src/parser.ts";

const fixture = readFileSync(new URL("./fixture-TODO.md", import.meta.url), "utf8");

test("real board round-trips byte for byte", () => {
  assert.equal(serializeBoard(parseBoard(fixture)), fixture);
});

test("reads lanes, the Complete marker and the archive", () => {
  const b = parseBoard(fixture);
  assert.deepEqual(b.lanes.map((l) => l.title), ["Later", "Week", "Today", "WiP", "Done"]);
  assert.deepEqual(b.lanes.map((l) => l.complete), [false, false, false, false, true]);
  assert.equal(b.lanes[3].cards.length, 0);
  assert.ok(b.archive && b.archive.length > 50);
  assert.equal(b.settings["tag-colors"]?.length, 6);
});

test("multi-line cards keep their continuation lines", () => {
  const b = parseBoard(fixture);
  const c = b.archive!.find((c) => c.title.startsWith("go through and de-claudify"))!;
  assert.deepEqual(c.rest, ["\t- [x] trim down tldr", "\t- [ ] better figure 1", "\t#sl"]);
  assert.equal(cardText(c), "go through and de-claudify my sections:\n- [x] trim down tldr\n- [ ] better figure 1\n#sl");
  const before = serializeBoard(b);
  setCardText(c, cardText(c));
  assert.equal(serializeBoard(b), before);
});

test("display pulls tags out and wraps times and dates like obsidian-kanban", () => {
  const m = cardDisplay(newCard("send regatta report @@{23:15} - @@{00:00}  #sailing"));
  assert.deepEqual(m.tags, ["#sailing"]);
  assert.deepEqual(m.times, ["23:15", "00:00"]);
  assert.match(m.markdown, /^send regatta report <span class="kanban-plugin__preview-time-wrapper kanban-plugin__date"><span class="kanban-plugin__preview-time kanban-plugin__item-metadata-time">23:15<\/span><\/span> - <span/);
  assert.doesNotMatch(m.markdown, /#sailing/);

  const d = cardDisplay(newCard("hand in problem set #work @{2026-09-25}"));
  assert.deepEqual(d.dates, ["2026-09-25"]);
  assert.match(d.markdown, /kanban-plugin__item-metadata-date">2026-09-25</);

  assert.deepEqual(cardDisplay(newCard("study for philosophy quiz ==!==")).tags, []);
  assert.deepEqual(cardDisplay(newCard("fix issue #12 today")).tags, []);
  assert.equal(cardDisplay(newCard("keep #tag inline"), { moveTags: false }).markdown, "keep #tag inline");
  // Not a valid time: left alone, as obsidian-kanban does.
  assert.equal(cardDisplay(newCard("at @@{soon}")).markdown, "at @@{soon}");
});

test("setting, adding and removing a card's times", () => {
  const c = newCard("send regatta report @@{23:15} - @@{00:00}  #sailing");
  setCardTime(c, 1, "00:30");
  assert.equal(c.title, "send regatta report @@{23:15} - @@{00:30}  #sailing");
  setCardTime(c, 1, null);
  assert.equal(c.title, "send regatta report @@{23:15}  #sailing");
  setCardTime(c, 0, null);
  assert.equal(c.title, "send regatta report  #sailing");
  setCardTime(c, 0, "21:00");
  assert.equal(c.title, "send regatta report  #sailing @@{21:00}");
});

test("setting and removing a card's date", () => {
  const c = newCard("hand in problem set #work @@{09:00}");
  setCardDate(c, "2026-10-21");
  assert.equal(c.title, "hand in problem set #work @@{09:00} @{2026-10-21}");
  setCardDate(c, "2026-10-22");
  assert.equal(c.title, "hand in problem set #work @@{09:00} @{2026-10-22}");
  setCardDate(c, null);
  assert.equal(c.title, "hand in problem set #work @@{09:00}");
});

test("changing settings rewrites only the settings block", () => {
  const b = parseBoard(fixture);
  updateSettings(b, { "list-collapse": [false, false, true, false, false] });
  const out = serializeBoard(b);
  const before = fixture.slice(0, fixture.indexOf("%% kanban:settings"));
  assert.ok(out.startsWith(before));
  assert.deepEqual(parseBoard(out).settings["list-collapse"], [false, false, true, false, false]);
  assert.deepEqual(parseBoard(out).settings["tag-colors"], b.settings["tag-colors"]);
});

test("an empty board and one without an archive round-trip", () => {
  const md = "---\n\nkanban-plugin: board\n\n---\n\n## A\n\n- [ ] one\n\n\n## B\n\n\n\n\n\n%% kanban:settings\n```\n{\"kanban-plugin\":\"board\"}\n```\n%%";
  assert.equal(serializeBoard(parseBoard(md)), md);
});

test("toggling a subtask touches only that line", () => {
  const c = newCard("parent\n- [ ] a\n- [x] b");
  assert.ok(toggleSubtask(c, 1));
  assert.deepEqual(c.rest, ["\t- [ ] a", "\t- [ ] b"]);
});

test("unknown content refuses to parse instead of being dropped", () => {
  assert.throws(() => parseBoard("---\n\nkanban-plugin: board\n\n---\n\n## A\n\nsome stray paragraph\n"), BoardParseError);
});
