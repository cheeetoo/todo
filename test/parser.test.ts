import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseBoard, serializeBoard, cardMeta, cardText, setCardText, newCard, toggleSubtask, BoardParseError,
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

test("meta pulls out tags, times and dates", () => {
  const m = cardMeta(newCard("send regatta report @@{23:15} - @@{00:00}  #sailing"));
  assert.deepEqual(m.tags, ["#sailing"]);
  assert.deepEqual(m.times, ["23:15", "00:00"]);
  assert.equal(m.body, "send regatta report");

  const d = cardMeta(newCard("hand in problem set #work @{2026-09-25}"));
  assert.deepEqual(d.dates, ["2026-09-25"]);
  assert.deepEqual(d.times, []);
  assert.equal(d.body, "hand in problem set");

  assert.deepEqual(cardMeta(newCard("study for philosophy quiz ==!==")).tags, []);
  assert.deepEqual(cardMeta(newCard("fix issue #12 today")).tags, []);
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
