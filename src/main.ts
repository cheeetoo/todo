import { Plugin, TFile, normalizePath, type WorkspaceLeaf } from "obsidian";
import { isBoardFile } from "./parser";
import { type Settings } from "./settings";
import { DateSuggest, TagSuggest, TimeSuggest } from "./suggest";
import { BoardView, VIEW_TYPE } from "./view";

const KANBAN_ID = "obsidian-kanban";

export default class TodoBoardPlugin extends Plugin {
  /** Global board settings: the Kanban plugin's own data.json, so both stay in step. */
  globalSettings: Partial<Settings> = {};

  /** Leaves the user switched to markdown, and for which file, so we don't flip them back. */
  private markdownLeaves = new WeakMap<WorkspaceLeaf, string>();

  async onload() {
    await this.loadGlobalSettings();

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
      id: "archive-completed",
      name: "Archive completed cards",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(BoardView);
        if (!view) return false;
        if (!checking) view.archiveCompleted();
        return true;
      },
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

  private async loadGlobalSettings() {
    const path = normalizePath(`${this.app.vault.configDir}/plugins/${KANBAN_ID}/data.json`);
    try {
      if (await this.app.vault.adapter.exists(path)) {
        this.globalSettings = JSON.parse(await this.app.vault.adapter.read(path));
      }
    } catch (e) {
      console.warn("TODO Board: couldn't read Kanban's settings", e);
    }
  }

  isBoard(file: TFile): boolean {
    return file.extension === "md" && isBoardFile(this.app.metadataCache.getFileCache(file)?.frontmatter);
  }

  kanbanEnabled(): boolean {
    return !!(this.app as any).plugins?.enabledPlugins?.has(KANBAN_ID);
  }

  async openAsBoard(leaf: WorkspaceLeaf, file: TFile, active = true) {
    this.markdownLeaves.delete(leaf);
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active });
  }

  async openAsMarkdown(leaf: WorkspaceLeaf) {
    const file = (leaf.view as unknown as BoardView).file;
    if (!file) return;
    this.markdownLeaves.set(leaf, file.path);
    // The Kanban plugin, if it's on, would grab this back unless told otherwise.
    const kanban = (this.app as any).plugins?.plugins?.[KANBAN_ID];
    if (kanban?.kanbanFileModes) kanban.kanbanFileModes[(leaf as any).id || file.path] = "markdown";
    await leaf.setViewState({ type: "markdown", state: { file: file.path }, active: true });
  }

  private adoptLeaves() {
    if (this.kanbanEnabled()) return;
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
