import { Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { isBoardFile } from "./parser";
import { BoardView, VIEW_TYPE } from "./view";

const KANBAN_ID = "obsidian-kanban";

export default class TodoBoardPlugin extends Plugin {
  /** Leaves the user switched to markdown, and for which file, so we don't flip them back. */
  private markdownLeaves = new WeakMap<WorkspaceLeaf, string>();

  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new BoardView(leaf, this));

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

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, _source, leaf) => {
        if (!(file instanceof TFile) || !this.isBoard(file)) return;
        if (leaf?.view.getViewType() === VIEW_TYPE) return;
        menu.addItem((item) =>
          item
            .setTitle("Open as board")
            .setIcon("kanban")
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
    const file = (leaf.view as BoardView).file;
    if (!file) return;
    this.markdownLeaves.set(leaf, file.path);
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
