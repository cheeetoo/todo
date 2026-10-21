import { Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type TodoBoardPlugin from "../main";
import { signIn } from "./google";

/** Where the Python cal-sync this replaces kept its sign-in (desktop only). */
function readCalSync(): { clientId: string; clientSecret: string; refreshToken: string; calendarId: string | null } | null {
  try {
    const fs = (window as any).require("fs");
    const dir = `${(window as any).require("os").homedir()}/.config/todocal`;
    const token = JSON.parse(fs.readFileSync(`${dir}/token.json`, "utf8"));
    let calendarId = null;
    try {
      calendarId = JSON.parse(fs.readFileSync(`${dir}/state.json`, "utf8")).calendar_id ?? null;
    } catch {}
    return { clientId: token.client_id, clientSecret: token.client_secret, refreshToken: token.refresh_token, calendarId };
  } catch {
    return null;
  }
}

export class SettingsTab extends PluginSettingTab {
  plugin: TodoBoardPlugin;

  constructor(plugin: TodoBoardPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display() {
    const el = this.containerEl;
    el.empty();
    const s = this.plugin.data.calendar;
    const save = () => this.plugin.saveSettings();
    const fail = (e: unknown) => new Notice(e instanceof Error ? e.message : String(e));

    new Setting(el).setName("Google Calendar").setHeading();
    new Setting(el)
      .setName("Sync to Google Calendar")
      .setDesc("Cards with a time or a date go on a calendar called TODO. Every device with this on keeps it up to date.")
      .addToggle((t) =>
        t.setValue(s.enabled).onChange(async (v) => {
          s.enabled = v;
          await save();
          if (v) await this.plugin.calendar.sync();
          this.display();
        }),
      );
    new Setting(el)
      .setName("Board")
      .setDesc("The board file to sync.")
      .addText((t) =>
        t.setValue(s.board).onChange(async (v) => {
          s.board = v.trim();
          await save();
        }),
      );

    const signedIn = !!s.refreshToken;
    const account = new Setting(el)
      .setName("Google account")
      .setDesc(
        signedIn ? "Signed in." : Platform.isDesktopApp ? "Not signed in." : "Not signed in. Sign in on your computer and it reaches this device through Sync.",
      );
    if (Platform.isDesktopApp) {
      const calSync = readCalSync();
      if (calSync && calSync.refreshToken !== s.refreshToken)
        account.addButton((b) =>
          b.setButtonText("Use cal-sync's sign-in").onClick(async () => {
            Object.assign(s, calSync);
            await save();
            this.display();
          }),
        );
      account.addButton((b) =>
        b.setButtonText(signedIn ? "Sign in again" : "Sign in").onClick(async () => {
          if (!s.clientId || !s.clientSecret) return fail("Fill in the OAuth client ID and secret first.");
          try {
            s.refreshToken = await signIn(s.clientId, s.clientSecret);
            await save();
            this.display();
          } catch (e) {
            fail(e);
          }
        }),
      );
    }
    if (signedIn)
      account.addButton((b) =>
        b.setButtonText("Sign out").onClick(async () => {
          s.refreshToken = "";
          await save();
          this.display();
        }),
      );

    if (Platform.isDesktopApp) {
      new Setting(el)
        .setName("OAuth client ID")
        .setDesc("From a desktop OAuth client in your Google Cloud project (only needed to sign in).")
        .addText((t) => t.setValue(s.clientId).onChange(async (v) => ((s.clientId = v.trim()), await save())));
      new Setting(el).setName("OAuth client secret").addText((t) => {
        t.inputEl.type = "password";
        t.setValue(s.clientSecret).onChange(async (v) => ((s.clientSecret = v.trim()), await save()));
      });
    }

    new Setting(el)
      .setName("Last sync")
      .setDesc(this.plugin.calendar.status)
      .addButton((b) =>
        b.setButtonText("Sync now").onClick(async () => {
          await this.plugin.calendar.sync();
          this.display();
        }),
      );
  }
}
