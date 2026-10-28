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

// ---- keyboard

const press = (v: any, key: string, init: KeyboardEventInit = {}) => v.onKey(new KeyboardEvent("keydown", { key, ...init }));
/** A run of plain key presses, one character each. */
const keys = (v: any, run: string) => [...run].forEach((k) => press(v, k));
const selected = (v: any) => [...v.contentEl.querySelectorAll(".tb-selected")];
/** Where the keyboard is, read off the page: the lane, and the card in it (-1 for an empty lane). */
const at = (v: any) => {
  const [el] = selected(v);
  const isCard = el.classList.contains("kanban-plugin__item-wrapper");
  const lane = el.closest(".kanban-plugin__lane-wrapper") ?? el.parentElement;
  return { lane: lanesEl(v).indexOf(lane), index: isCard ? cardsIn(lane).indexOf(el) : -1 };
};
const titles = (v: any, lane: number) => lanesOf(v)[lane].cards.map((c) => c.title);

test("j/k/h/l move the selection; the first press just lands", async () => {
  const v = await open();
  assert.equal(selected(v).length, 0);
  assert.equal(press(v, "j"), true);
  assert.deepEqual(at(v), { lane: 2, index: 0 }, "first press lands on Today's first card");
  keys(v, "jjj");
  assert.deepEqual(at(v), { lane: 2, index: 3 });
  keys(v, "hh");
  assert.deepEqual(at(v), { lane: 0, index: 0 }, "a short lane pulls the row in");
  keys(v, "ll");
  assert.deepEqual(at(v), { lane: 2, index: 0 });
  keys(v, "jjj");
  press(v, "ArrowUp");
  assert.equal(at(v).index, 2);
  keys(v, "kkkkk");
  assert.equal(at(v).index, 0, "stops at the top");
  keys(v, "jjjhhh");
  assert.equal(at(v).lane, 0, "stops at the first lane");
  keys(v, "ll");
  press(v, "G");
  assert.equal(at(v).index, 6);
  keys(v, "gg");
  assert.equal(at(v).index, 0);
  keys(v, "gjg");
  assert.equal(at(v).index, 1, "a g that isn't followed by g does nothing");
  assert.equal(selected(v).length, 1);
});

test("the selection lands in an empty lane; Escape drops it", async () => {
  const v = await open();
  keys(v, "jl");
  assert.deepEqual(at(v), { lane: 3, index: -1 });
  keys(v, "jk");
  assert.deepEqual(at(v), { lane: 3, index: -1 }, "nothing to move to");
  keys(v, "l");
  assert.equal(at(v).lane, 4);
  assert.equal(press(v, "Escape"), true);
  assert.equal(selected(v).length, 0);
  assert.equal(press(v, "Escape"), false, "Escape is left alone when nothing is selected");
});

test("Shift+J/K reorders in the lane; Shift+L/H moves to the next lane, and the selection follows", async () => {
  const v = await open();
  const today = titles(v, 2);
  keys(v, "jj");
  assert.deepEqual(at(v), { lane: 2, index: 1 });
  press(v, "J");
  await v.render();
  assert.deepEqual(titles(v, 2).slice(0, 3), [today[0], today[2], today[1]]);
  assert.deepEqual(at(v), { lane: 2, index: 2 });
  press(v, "K", { shiftKey: true });
  press(v, "ArrowUp", { shiftKey: true });
  await v.render();
  assert.deepEqual(titles(v, 2).slice(0, 3), [today[1], today[0], today[2]]);
  assert.deepEqual(at(v), { lane: 2, index: 0 });

  // Right, into the empty WiP lane, then on into Done (which ticks it).
  press(v, "L");
  await v.render();
  assert.deepEqual(at(v), { lane: 3, index: 0 });
  assert.equal(titles(v, 3)[0], today[1]);
  press(v, "L");
  await v.render();
  assert.equal(lanesOf(v)[4].cards[0].title, today[1]);
  assert.equal(lanesOf(v)[4].cards[0].check, "x");
  assert.deepEqual(at(v), { lane: 4, index: 0 });
  press(v, "L");
  assert.equal(v.saves, 5, "the end of the board moves nothing");

  keys(v, "uuuuu");
  assert.equal(v.getViewData(), fixture);
});

test("rapid presses see each other even before the board has redrawn", async () => {
  const v = await open();
  keys(v, "jj");
  press(v, "J");
  press(v, "J");
  press(v, "J");
  await v.render();
  assert.equal(titles(v, 2)[4], titles(await open(), 2)[1], "the card went down three places");
  assert.deepEqual(at(v), { lane: 2, index: 4 });
});

test("dd deletes and u undoes; a lone d does nothing", async () => {
  const v = await open();
  keys(v, "jj");
  const before = titles(v, 2);
  keys(v, "dj");
  assert.equal(titles(v, 2).length, before.length, "d then another key deletes nothing");
  keys(v, "kdd");
  await v.render();
  assert.deepEqual(titles(v, 2), before.filter((_, i) => i !== 1));
  assert.deepEqual(at(v), { lane: 2, index: 1 }, "the next card slides under the selection");
  keys(v, "G");
  keys(v, "dd");
  await v.render();
  assert.deepEqual(at(v), { lane: 2, index: 4 }, "deleting the last card steps back");
  keys(v, "uu");
  assert.equal(v.getViewData(), fixture);
});

test("collapsed lanes and search misses are skipped", async () => {
  const v = await open();
  v.toggleCollapse(1);
  await v.render();
  keys(v, "jh");
  assert.equal(at(v).lane, 0, "Week is collapsed");
  keys(v, "l");
  assert.equal(at(v).lane, 2);

  v.searchQuery = "tweet";
  await v.render();
  keys(v, "h");
  assert.equal(at(v).lane, 2, "no other lane matches");
  keys(v, "gg");
  assert.equal(at(v).index, 2);
  keys(v, "j");
  assert.equal(at(v).index, 3, "tweet thread figures");
  keys(v, "j");
  assert.equal(at(v).index, 3, "nothing else matches");
  press(v, "K");
  assert.ok(titles(v, 2)[2].includes("figures") && titles(v, 2)[3].includes("content"), "swapped with the other match");
  assert.equal(press(v, "a"), false, "adding is off while searching");
});

test("Enter and e edit the selected card; a adds to its lane; neither does anything unselected", async () => {
  const v = await open();
  const opened: any[] = [];
  v.editCard = (wrapper: any, card: any) => opened.push([wrapper, card]);
  const added: any[] = [];
  v.openAddForm = (_el: any, lane: number) => added.push(lane);
  assert.equal(press(v, "Enter"), false);
  assert.equal(press(v, "a"), true, "with nothing selected, a adds to Today");
  assert.deepEqual(added, [2]);
  assert.equal(selected(v).length, 0, "and still nothing is highlighted");
  added.length = 0;
  keys(v, "jj");
  assert.equal(press(v, "Enter"), true);
  assert.equal(press(v, "e"), true);
  assert.equal(opened.length, 2);
  assert.equal(opened[0][1].title, titles(v, 2)[1]);
  assert.equal(opened[0][0], cardsIn(lanesEl(v)[2])[1]);
  assert.equal(press(v, "a"), true);
  assert.deepEqual(added, [2]);
});

test("a click selects the card; keys are ignored with a modifier held, while typing, or on an unreadable board", async () => {
  const v = await open();
  cardsIn(lanesEl(v)[2])[4].dispatchEvent(new Event("pointerdown", { bubbles: true }));
  v.onPointerDownAnywhere({ target: cardsIn(lanesEl(v)[2])[4] });
  assert.deepEqual(at(v), { lane: 2, index: 4 });
  keys(v, "j");
  assert.equal(at(v).index, 5);

  assert.equal(press(v, "j", { ctrlKey: true }), false);
  assert.equal(press(v, "j", { metaKey: true }), false);
  const input = document.createElement("input");
  const typing: any = { key: "j", target: input, ctrlKey: false, metaKey: false, altKey: false, isComposing: false };
  assert.equal(v.onKey(typing), false);
  assert.equal(at(v).index, 5);

  const bad = await open("---\n\nkanban-plugin: board\n\n---\n\n## A\n\nstray paragraph\n");
  assert.equal(press(bad, "j"), false);
});
