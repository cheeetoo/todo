import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BoardView } from "../src/view.ts";
import { parseBoard, cardToMd } from "../src/parser.ts";

const fixture = readFileSync(new URL("./fixture-TODO.md", import.meta.url), "utf8");
const g = globalThis as any;
const plugin = { openAsMarkdown() {} };

async function open(data = fixture) {
  const v: any = new BoardView({} as any, plugin as any);
  v.setViewData(data, true);
  await v.render();
  return v;
}
const lanesOf = (v: any) => parseBoard(v.getViewData()).lanes;
const lanesEl = (v: any) => [...v.contentEl.querySelectorAll(".kanban-plugin__lane-wrapper")];
const cardsIn = (laneEl: any) => [...laneEl.querySelectorAll(".kanban-plugin__item-wrapper")];

test("renders obsidian-kanban's DOM, and opening writes nothing", async () => {
  const v = await open();
  const lanes = lanesEl(v);
  assert.equal(lanes.length, 5);
  assert.equal(cardsIn(lanes[2]).length, 7);
  assert.equal(v.saves, 0);
  assert.equal(v.getViewData(), fixture);

  const done = cardsIn(lanes[4])[0];
  assert.ok(done.querySelector(".kanban-plugin__item.is-complete.has-tag-sailing"));
  assert.ok(done.querySelector(".kanban-plugin__item-prefix-button[aria-label='Clear card']"), "Complete lanes show the clear button");
  const tag = done.querySelector(".kanban-plugin__item-tags a.tag.kanban-plugin__item-tag");
  assert.equal(tag.textContent, "#sailing");
  assert.equal(tag.style.getPropertyValue("--tag-background"), "rgba(89, 122, 182, 1)");
  const times = [...done.querySelectorAll(".kanban-plugin__item-metadata-time")].map((t: any) => t.textContent);
  assert.deepEqual(times, ["23:15", "00:00"]);
  // The empty-lane placeholder obsidian-kanban keeps at the end of every lane
  assert.ok(lanes[3].querySelector(".kanban-plugin__lane-items > .kanban-plugin__placeholder:only-child"));
});

test("moving a card saves it, and undo restores the exact file", async () => {
  const v = await open();
  const card = lanesOf(v)[1].cards[0];
  v.moveCard({ place: 1, index: 0 }, cardToMd(card), 2, 99);
  const l = lanesOf(v);
  assert.equal(l[1].cards.length, 6);
  assert.equal(l[2].cards.at(-1)!.title, card.title);
  assert.equal(v.saves, 1);
  v.undo();
  assert.equal(v.getViewData(), fixture);
});

test("moving into Done ticks a card; moving out unticks it", async () => {
  const v = await open();
  const card = lanesOf(v)[2].cards[0];
  v.moveCard({ place: 2, index: 0 }, cardToMd(card), 4, 0);
  const ticked = lanesOf(v)[4].cards[0];
  assert.equal(ticked.check, "x");
  v.moveCard({ place: 4, index: 0 }, cardToMd(ticked), 1, 0);
  assert.equal(lanesOf(v)[1].cards[0].check, " ");
});

test("a card is found by its text if the file shifted underneath", async () => {
  const v = await open();
  const md = cardToMd(lanesOf(v)[2].cards[3]);
  // Someone (Sync, another pane) added a card at the top of Today.
  v.setViewData(fixture.replace("## Today\n\n", "## Today\n\n- [ ] new from phone\n"), false);
  v.moveCard({ place: 2, index: 3 }, md, 0, 0); // stale index: now points at a different card
  const l = lanesOf(v);
  assert.equal(cardToMd(l[0].cards[0]), md);
  assert.equal(l[2].cards[0].title, "new from phone");
});

test("the Done lane's button clears a card away for good", async () => {
  const v = await open();
  const first = cardsIn(lanesEl(v)[4])[0];
  first.querySelector(".kanban-plugin__item-prefix-button").click();
  const b = parseBoard(v.getViewData());
  assert.equal(b.lanes[4].cards.length, 4);
  assert.equal(b.archive!.length, parseBoard(fixture).archive!.length, "nothing is added to the archive");
});

test("clear completed deletes the Done lane; the old archive section is left as it was", async () => {
  const v = await open();
  v.clearCompleted();
  const out = v.getViewData();
  const b = parseBoard(out);
  assert.equal(b.lanes[4].cards.length, 0);
  assert.equal(out.slice(out.indexOf("***")), fixture.slice(fixture.indexOf("***")));
});

test("a card that's gone isn't hunted down in the old archive", async () => {
  const v = await open();
  // "eat food" exists only in the archive; a stale ref to it must not delete it there.
  v.deleteCard({ place: 2, index: 0 }, "- [x] eat food");
  assert.equal(v.getViewData(), fixture);
});

test("collapsing and reordering lanes keeps list-collapse in step", async () => {
  const v = await open();
  v.toggleCollapse(3);
  assert.deepEqual(parseBoard(v.getViewData()).settings["list-collapse"], [false, false, false, true, false]);
  await v.render();
  assert.ok(lanesEl(v)[3].classList.contains("collapse-horizontal"));
  v.moveLane(3, 0);
  const b = parseBoard(v.getViewData());
  assert.deepEqual(b.lanes.map((l) => l.title), ["WiP", "Later", "Week", "Today", "Done"]);
  assert.deepEqual(b.settings["list-collapse"], [true, false, false, false, false]);
  // Nothing else in the settings changed.
  assert.deepEqual(b.settings["tag-colors"], parseBoard(fixture).settings["tag-colors"]);
});

test("the card menu offers obsidian-kanban's actions", async () => {
  const v = await open();
  const wrapper = cardsIn(lanesEl(v)[2])[0];
  wrapper.querySelector(".kanban-plugin__item-postfix-button").click();
  const titles = g.lastMenu.items.map((i: any) => i.title);
  for (const t of ["Edit card", "Move to top", "Move to bottom", "Delete card", "Add date", "Add time", "Move to list"])
    assert.ok(titles.includes(t), `menu has ${t}: ${titles}`);
  g.lastMenu.items.find((i: any) => i.title === "Move to list").submenu.items.find((i: any) => i.title === "WiP").click();
  assert.equal(lanesOf(v)[3].cards[0].title, "de-pangram #work");
});

test("search hides other cards and folds empty lanes, without a redraw", async () => {
  const v = await open();
  v.searchQuery = "tweet";
  await v.render();
  const visible = (laneEl: any) => cardsIn(laneEl).filter((c: any) => !c.classList.contains("tb-search-hidden")).length;
  const lanes = lanesEl(v);
  assert.equal(visible(lanes[2]), 2);
  assert.ok(lanes[0].classList.contains("collapse-horizontal"));
  assert.ok(!lanes[2].classList.contains("collapse-horizontal"));
});

test("ticking a sub-task inside a card", async () => {
  const md = fixture.replace("- [ ] de-pangram #work", "- [ ] de-pangram #work\n\t- [ ] intro\n\t- [ ] outro");
  const v = await open(md);
  const box = cardsIn(lanesEl(v)[2])[0].querySelectorAll("input.task-list-item-checkbox")[1];
  box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.deepEqual(lanesOf(v)[2].cards[0].rest, ["\t- [ ] intro", "\t- [x] outro"]);
});

test("an unreadable file shows an error and is never rewritten", async () => {
  const bad = "---\n\nkanban-plugin: board\n\n---\n\n## A\n\nstray paragraph\n";
  const v = await open(bad);
  assert.ok(v.contentEl.querySelector(".tb-error"));
  v.clearCompleted();
  assert.equal(v.getViewData(), bad);
  assert.equal(v.saves, 0);
});
