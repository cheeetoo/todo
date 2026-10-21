import { Plugin, TFile, type WorkspaceLeaf } from "obsidian";
import { CalendarSync, DEFAULT_CALENDAR, type CalendarSettings } from "./calendar/sync";
import { SettingsTab } from "./calendar/tab";
import { isBoardFile } from "./parser";
import { DateSuggest, TagSuggest, TimeSuggest } from "./suggest";
import { BoardView, VIEW_TYPE } from "./view";

const KANBAN_ID = "obsidian-kanban";

export default class TodoBoardPlugin extends Plugin {
  /** This plugin's own settings (data.json, which Sync carries to other devices). */
  settings: { calendar: CalendarSettings } = { calendar: { ...DEFAULT_CALENDAR } };
  calendar = new CalendarSync(this);

  /** Leaves the user switched to markdown, and for which file, so we don't flip them back. */
  private markdownLeaves = new WeakMap<WorkspaceLeaf, string>();

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new SettingsTab(this));
    this.calendar.start();

    this.registerView(VIEW_TYPE, (leaf) => new BoardView(leaf, this));
    this.registerHoverLinkSource(VIEW_TYPE, { display: "TODO Board", defaultMod: true });

    // Ours go first so they win over Obsidian's built-in tag suggester in cards.
    const suggests = [new TagSuggest(this.app), new TimeSuggest(this.app), new DateSuggest(this.app)];
    for (const s of suggests) this.registerEditorSuggest(s);
    const list: unknown[] | undefined = (this.app.workspace as any).editorSuggest?.suggests;
    if (list) {
      for (const s of suggests) list.remove(s);
      list.unshift(...suggests);
    }

    this.addCommand({
      id: "toggle-view",
      name: "Toggle between board and markdown",
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getMostRecentLeaf();
        const file = this.app.workspace.getActiveFile();
        if (!leaf || !file || !this.isBoard(file)) return false;
        if (!checking) {
          if (leaf.view.getViewType() === VIEW_TYPE) this.openAsMarkdown(leaf);
          else this.openAsBoard(leaf, file);
        }
        return true;
      },
    });

    this.addCommand({
      id: "clear-completed",
      name: "Clear completed cards",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(BoardView);
        if (!view) return false;
        if (!checking) view.clearCompleted();
        return true;
      },
    });

    this.addCommand({
      id: "sync-calendar",
      name: "Sync calendar now",
      callback: () => this.calendar.sync(),
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, _source, leaf) => {
        if (!(file instanceof TFile) || !this.isBoard(file)) return;
        if (leaf?.view.getViewType() === VIEW_TYPE) return;
        menu.addItem((item) =>
          item
            .setTitle("Open as board")
            .setIcon("lucide-trello")
            .setSection("pane")
            .onClick(() => this.openAsBoard(leaf ?? this.app.workspace.getLeaf(), file)),
        );
      }),
    );

    // Boards open as boards — but only while the Kanban plugin is off, so the
    // two never fight over the same tab.
    this.registerEvent(this.app.workspace.on("file-open", () => this.adoptLeaves()));
    this.app.workspace.onLayoutReady(() => this.adoptLeaves());
  }

  async loadSettings() {
    const saved = await this.loadData();
    this.settings = { calendar: { ...DEFAULT_CALENDAR, ...saved?.calendar } };
  }

  saveSettings() {
    return this.saveData(this.settings);
  }

  /** Another device changed data.json (e.g. signed in) and Sync brought it here. */
  async onExternalSettingsChange() {
    await this.loadSettings();
  }

  isBoard(file: TFile): boolean {
    return file.extension === "md" && isBoardFile(this.app.metadataCache.getFileCache(file)?.frontmatter);
  }

  async openAsBoard(leaf: WorkspaceLeaf, file: TFile, active = true) {
    this.markdownLeaves.delete(leaf);
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active });
  }

  async openAsMarkdown(leaf: WorkspaceLeaf) {
    const file = (leaf.view as unknown as BoardView).file;
    if (!file) return;
    this.markdownLeaves.set(leaf, file.path);
    await leaf.setViewState({ type: "markdown", state: { file: file.path }, active: true });
  }

  private adoptLeaves() {
    if ((this.app as any).plugins?.enabledPlugins?.has(KANBAN_ID)) return;
    const active = this.app.workspace.getMostRecentLeaf();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const state = leaf.getViewState();
      const path = state.state?.file as string | undefined;
      if (!path) return;
      // "kanban" leaves are left over from the Kanban plugin's saved layout.
      if (state.type !== "markdown" && state.type !== "kanban") return;
      if (this.markdownLeaves.get(leaf) === path) return;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile && this.isBoard(file)) this.openAsBoard(leaf, file, leaf === active);
    });
  }
}
