import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseBoard } from "../src/parser.ts";
import { plan, readCard, parseClock, sha1 } from "../src/calendar/plan.ts";

// Events computed by the Python tool this replaces (~/fun/cal), for three boards
// at ten moments (late night, past midnight, both DST changes). Run in New York.
const cases = JSON.parse(readFileSync(new URL("./calendar-parity.json", import.meta.url), "utf8"));
const boards: Record<string, string> = {
  "synthetic.md": "calendar-synthetic.md",
  "current.md": "calendar-current.md",
  "fixture.md": "fixture-TODO.md",
};

// Times are compared as instants: in the March gap Python writes 02:00-05:00
// where we write 03:00-04:00, the same moment.
const instant = (edge: any) => ("date" in edge ? edge.date : Date.parse(edge.dateTime));
const shape = (e: any) => ({ ...e, start: instant(e.start), end: instant(e.end) });

// One known difference: in November's repeated 01:00 hour Python did wall-clock
// arithmetic for the 15-minute stub before a shared deadline and landed an hour
// early. We put it 15 minutes before, as intended.
const pythonDstSlip = (c: any, key: string, e: any) =>
  c.board === "synthetic.md" && ["2026-10-31T23:30:00", "2026-11-01T01:30:00"].includes(c.now) && e.summary === "duplicate" && key.endsWith("01")
    ? { ...e, start: e.start + 3_600_000 }
    : e;

test("produces the events the Python tool did", () => {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "America/New_York", "run with TZ=America/New_York");
  for (const c of cases) {
    const board = parseBoard(readFileSync(new URL(`./${boards[c.board]}`, import.meta.url), "utf8"));
    const [d, t] = c.now.split("T");
    const [y, mo, da] = d.split("-").map(Number);
    const [h, mi] = t.split(":").map(Number);
    const { events } = plan(board, new Date(y, mo - 1, da, h, mi), "TODO.md", "America/New_York");
    const got = Object.fromEntries(
      [...events].map(([k, e]) => [k, shape({ summary: e.summary, description: e.description, start: e.start, end: e.end, day: e.extendedProperties.private.todoDay })]),
    );
    const want = Object.fromEntries(Object.entries(c.events).map(([k, e]) => [k, pythonDstSlip(c, k, shape(e))]));
    assert.deepEqual(got, want, `${c.board} at ${c.now}`);
  }
});

test("reading a card", () => {
  assert.deepEqual(readCard("range meeting #sl @@{16:00} - @@{18:30}"), { title: "range meeting", tags: ["sl"], at: 18 * 60 + 30, atStart: 16 * 60, on: null });
  assert.deepEqual(readCard("not a clock @@{soon} stays").title, "not a clock @@{soon} stays");
  assert.equal(parseClock("12am"), 0);
  assert.equal(parseClock("10:15 PM"), 22 * 60 + 15);
  assert.equal(parseClock("24:00"), null);
});

test("sha1 matches Python's hashlib", () => {
  assert.equal(sha1(""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
  assert.equal(sha1("2026-10-20|read over post ✓"), "7a3dc9c9cad8451b43f1acee888f7ac3e1c8059c");
  assert.equal(sha1("x".repeat(100)), "50e483690ec481f4af7f6fb524b2b99eb1716565");
});

// ---------------------------------------------------------------- reconcile

import { reconcile } from "../src/calendar/sync.ts";

/** An in-memory calendar that filters by the private marker like Google does. */
function fakeCalendar() {
  let n = 0;
  const events = new Map<string, any>();
  return {
    events,
    api: {
      events: async (_c: string, marker: string) => [...events.values()].filter((e) => e.extendedProperties?.private?.[marker] === "1"),
      insert: async (_c: string, body: any) => void events.set(`e${++n}`, { ...structuredClone(body), id: `e${n}` }),
      patch: async (_c: string, id: string, body: any) => void events.set(id, { ...structuredClone(body), id }),
      delete: async (_c: string, id: string) => void events.delete(id),
    } as any,
  };
}

const board = (today: string) =>
  parseBoard(`---\n\nkanban-plugin: board\n\n---\n\n## Today\n\n${today}\n\n\n## Done\n\n**Complete**\n\n\n\n`);
const NOW = new Date(2026, 9, 20, 21, 0);
const sync = (cal: ReturnType<typeof fakeCalendar>, today: string) =>
  reconcile(cal.api, "cal", plan(board(today), NOW, "TODO.md", "America/New_York"));

test("reconcile creates, leaves alone, patches and removes", async () => {
  const cal = fakeCalendar();
  const cards = "- [ ] read post #sl @@{22:30}\n- [ ] sleep @@{23:30}";
  assert.deepEqual(await sync(cal, cards), { created: 2, updated: 0, deleted: 0, unchanged: 0 });
  assert.deepEqual(await sync(cal, cards), { created: 0, updated: 0, deleted: 0, unchanged: 2 });
  assert.deepEqual(await sync(cal, "- [ ] read post #sl @@{22:45}\n- [ ] sleep @@{23:30}"), { created: 0, updated: 2, deleted: 0, unchanged: 0 });
  assert.deepEqual(await sync(cal, "- [ ] sleep @@{23:30}"), { created: 0, updated: 1, deleted: 1, unchanged: 0 });
  assert.deepEqual([...cal.events.values()].map((e) => e.summary), ["sleep"]);
});

test("reconcile never touches events it didn't make, and clears duplicates", async () => {
  const cal = fakeCalendar();
  cal.events.set("mine", { id: "mine", summary: "dentist" });
  await sync(cal, "- [ ] sleep @@{23:30}");
  const [, made] = [...cal.events.values()];
  cal.events.set("dup", { ...made, id: "dup" }); // as if a second device created it too
  assert.deepEqual(await sync(cal, "- [ ] sleep @@{23:30}"), { created: 0, updated: 0, deleted: 1, unchanged: 1 });
  assert.ok(cal.events.has("mine"));
  assert.equal(cal.events.size, 2);
});
