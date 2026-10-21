import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BoardView } from "../src/view.ts";
import { parseBoard } from "../src/parser.ts";

const fixture = readFileSync(new URL("./fixture-TODO.md", import.meta.url), "utf8");
const g = globalThis as any;

function open() {
  const v: any = new BoardView({} as any, { openAsMarkdown() {} } as any);
  v.setViewData(fixture, true);
  return v;
}
const lanesOf = (v: any) => parseBoard(v.getViewData()).lanes;
const menuClick = (title: string) => {
  const it = g.lastMenu.items.find((i: any) => i.title.startsWith(title));
  assert.ok(it, `menu item ${title} in ${g.lastMenu.items.map((i: any) => i.title)}`);
  it.click();
};

test("renders every lane and card, and opening writes nothing", () => {
  const v = open();
  const lanes = v.contentEl.querySelectorAll(".tb-lane");
  assert.equal(lanes.length, 5);
  assert.equal(lanes[2].querySelectorAll(".tb-card").length, 7);
  assert.equal(v.saves, 0);
  assert.equal(v.getViewData(), fixture);
  const done = lanes[4].querySelector(".tb-card");
  assert.equal(done.querySelector(".tb-tag").textContent, "#sailing");
  assert.equal(done.querySelector(".tb-tag").style.getPropertyValue("--tb-tag-bg"), "rgba(89, 122, 182, 1)");
  assert.match(done.querySelector(".tb-card-meta").textContent, /23:15 – 00:00/);
  assert.doesNotMatch(done.querySelector(".tb-card-title").textContent, /@@|#sailing/);
});

test("move Week → Today via the menu, then undo restores the exact file", () => {
  const v = open();
  const card = v.contentEl.querySelectorAll(".tb-lane")[1].querySelector(".tb-card");
  card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  menuClick("Move to Today");
  const l = lanesOf(v);
  assert.equal(l[1].cards.length, 6);
  assert.equal(l[2].cards.length, 8);
  assert.equal(l[2].cards.at(-1)!.title, "start fun doc on agendas and future or whatnot #work");
  assert.equal(v.saves, 1);
  v.undo();
  assert.equal(v.getViewData(), fixture);
});

test("moving into Done ticks the card; moving out unticks it", () => {
  const v = open();
  v.moveCard({ place: 2, index: 0 }, 4, 0);
  assert.equal(lanesOf(v)[4].cards[0].check, "x");
  v.moveCard({ place: 4, index: 0 }, 1, 0);
  assert.equal(lanesOf(v)[1].cards[0].check, " ");
  assert.equal(lanesOf(v)[1].cards[0].title, "de-pangram #work");
});

test("same-lane drag reorders correctly in both directions", () => {
  const v = open();
  v.moveCard({ place: 2, index: 0 }, 2, 2); // index excludes the dragged card
  assert.deepEqual(lanesOf(v)[2].cards.slice(0, 3).map((c) => c.title.split(" ")[0]), ["respond", "tweet", "de-pangram"]);
});

test("add, edit, archive and delete", () => {
  const v = open();
  v.addingTo = 3;
  v.render();
  const input = v.contentEl.querySelectorAll(".tb-lane")[3].querySelector("textarea");
  input.value = "new thing #life @@{21:00}";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(lanesOf(v)[3].cards[0].title, "new thing #life @@{21:00}");
  assert.ok(v.contentEl.querySelectorAll(".tb-lane")[3].querySelector("textarea"), "form stays open");

  const card = v.contentEl.querySelectorAll(".tb-lane")[3].querySelector(".tb-card");
  card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  const edit = card.querySelector("textarea");
  edit.value = "renamed #life\n- [ ] sub";
  edit.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.deepEqual(lanesOf(v)[3].cards[0].rest, ["\t- [ ] sub"]);

  const box = v.contentEl.querySelectorAll(".tb-lane")[3].querySelector("input.task-list-item-checkbox");
  box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.deepEqual(lanesOf(v)[3].cards[0].rest, ["\t- [x] sub"]);

  v.archiveCard({ place: 3, index: 0 });
  assert.equal(parseBoard(v.getViewData()).archive![0].title, "renamed #life");
  v.deleteCard({ place: "archive", index: 0 });
  assert.equal(v.getViewData(), fixture);
});

test("an unreadable file shows an error and is never rewritten", () => {
  const v: any = new BoardView({} as any, {} as any);
  const bad = "---\n\nkanban-plugin: board\n\n---\n\n## A\n\nstray paragraph\n";
  v.setViewData(bad, true);
  assert.ok(v.contentEl.querySelector(".tb-error"));
  v.moveCard({ place: 0, index: 0 }, 0, 0);
  assert.equal(v.getViewData(), bad);
  assert.equal(v.saves, 0);
});
