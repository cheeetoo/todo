// Keeps a Google calendar called TODO in step with the board: a few seconds
// after the board changes (here or via Sync), every 15 minutes (so missed
// deadlines roll on and the current card still starts "now"), and at startup.

import { Notice, TFile, debounce } from "obsidian";
import type TodoBoardPlugin from "../main";
import { parseBoard } from "../parser";
import { Google, type Account, type LiveEvent } from "./google";
import { MARKER, plan, type EventBody } from "./plan";

const CALENDAR_NAME = "TODO";
const RESYNC_MINUTES = 15;

export interface CalendarSettings {
  enabled: boolean;
  /** Path of the board to sync. */
  board: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId: string | null;
}

export const DEFAULT_CALENDAR: CalendarSettings = {
  enabled: false,
  board: "TODO.md",
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  calendarId: null,
};

export interface Changes {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

/** The calls reconcile makes (tests pass a fake). */
export type CalendarApi = Pick<Google, "events" | "insert" | "patch" | "delete">;

const instant = (edge: LiveEvent["start"]) => (!edge ? null : "date" in edge ? edge.date : Date.parse(edge.dateTime));

function differs(live: LiveEvent, want: EventBody): boolean {
  return (
    live.summary !== want.summary ||
    (live.description ?? "") !== want.description ||
    instant(live.start) !== instant(want.start) ||
    instant(live.end) !== instant(want.end)
  );
}

/** Make the calendar's marked events in the window match the plan exactly. */
export async function reconcile(api: CalendarApi, calendarId: string, want: ReturnType<typeof plan>): Promise<Changes> {
  const changes: Changes = { created: 0, updated: 0, deleted: 0, unchanged: 0 };
  const live = new Map<string, LiveEvent>();
  const stale: LiveEvent[] = [];
  for (const e of await api.events(calendarId, MARKER, want.from, want.to)) {
    const key = e.extendedProperties?.private?.todoKey;
    if (!key) continue;
    // Two devices syncing at once can both create an event; keep one.
    if (live.has(key)) stale.push(e);
    else live.set(key, e);
  }

  for (const [key, body] of want.events) {
    const e = live.get(key);
    if (!e) {
      await api.insert(calendarId, body);
      changes.created++;
    } else if (differs(e, body)) {
      await api.patch(calendarId, e.id, body);
      changes.updated++;
    } else changes.unchanged++;
  }
  for (const [key, e] of live) if (!want.events.has(key)) stale.push(e);
  for (const e of stale) {
    await api.delete(calendarId, e.id);
    changes.deleted++;
  }
  return changes;
}

export function describe(c: Changes): string {
  const parts = [
    c.created && `${c.created} created`,
    c.updated && `${c.updated} updated`,
    c.deleted && `${c.deleted} removed`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : `up to date (${c.unchanged} events)`;
}

export class CalendarSync {
  status = "Not synced yet.";
  private plugin: TodoBoardPlugin;
  private google: { account: string; client: Google } | null = null;
  private running = false;
  private again = false;
  private failing = false;

  constructor(plugin: TodoBoardPlugin) {
    this.plugin = plugin;
  }

  private get settings() {
    return this.plugin.data.calendar;
  }

  start() {
    const { app } = this.plugin;
    const soon = debounce(() => this.sync(), 3000, true);
    this.plugin.registerEvent(app.vault.on("modify", (f) => f.path === this.settings.board && soon()));
    this.plugin.registerInterval(window.setInterval(() => this.sync(), RESYNC_MINUTES * 60_000));
    app.workspace.onLayoutReady(() => this.sync());
  }

  private account(): Account | null {
    const { clientId, clientSecret, refreshToken } = this.settings;
    return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : null;
  }

  async sync(): Promise<void> {
    const account = this.account();
    if (!this.settings.enabled || !account) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    const time = () => window.moment().format("HH:mm");
    try {
      const { vault } = this.plugin.app;
      const file = vault.getAbstractFileByPath(this.settings.board);
      if (!(file instanceof TFile)) throw new Error(`There's no board at ${this.settings.board}.`);
      const board = parseBoard(await vault.read(file));
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

      const id = JSON.stringify(account);
      if (this.google?.account !== id) this.google = { account: id, client: new Google(account) };
      const google = this.google.client;

      const calendarId = await google.calendar(CALENDAR_NAME, timeZone, this.settings.calendarId);
      if (calendarId !== this.settings.calendarId) {
        this.settings.calendarId = calendarId;
        await this.plugin.saveSettings();
      }
      const changes = await reconcile(google, calendarId, plan(board, new Date(), file.name, timeZone));
      this.status = `Synced at ${time()}: ${describe(changes)}.`;
      this.failing = false;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.status = `Failed at ${time()}: ${message}`;
      // Once per run of failures, not every 15 minutes.
      if (!this.failing) new Notice(`TODO Board couldn't sync the calendar: ${message}`);
      this.failing = true;
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.sync();
      }
    }
  }
}
