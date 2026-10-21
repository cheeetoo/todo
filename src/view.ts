import {
  Component,
  Keymap,
  MarkdownRenderer,
  Menu,
  Notice,
  Platform,
  Scope,
  TextFileView,
  type TFile,
  moment,
  setIcon,
  type WorkspaceLeaf,
} from "obsidian";
import { DragController, type DropResult } from "./dnd";
import { allowNewLine, mountEditor, type MountedEditor } from "./editor";
import type TodoBoardPlugin from "./main";
import {
  BoardParseError,
  cardDisplay,
  cardText,
  cardToMd,
  newCard,
  parseBoard,
  serializeBoard,
  setCardDate,
  setCardText,
  setCardTime,
  toggleSubtask,
  updateSettings,
  type Board,
  type Card,
  type Lane,
  type TagColor,
} from "./parser";
import { resolveSettings, DEFAULTS, type Settings } from "./settings";
import { BoardSettingsModal } from "./settingsModal";

export const VIEW_TYPE = "todo-board";

/** obsidian-kanban's class names, so its stylesheet (and any theme styling it) applies as-is. */
const c = (cls: string) => `kanban-plugin__${cls}`;

/** Where a card lives: a lane index, or "archive". */
type Place = number | "archive";
export interface CardRef {
  place: Place;
  index: number;
}

type LaneAction = "archive-items" | "archive" | "delete";
const CONFIRM: Record<LaneAction, { text: string; button: string }> = {
  delete: { text: "Are you sure you want to delete this list and all its cards?", button: "Yes, delete list" },
  archive: { text: "Are you sure you want to archive this list and all its cards?", button: "Yes, archive list" },
  "archive-items": { text: "Are you sure you want to archive all cards in this list?", button: "Yes, archive cards" },
};

const HISTORY_LIMIT = 100;
const GRIP_PATH = "M5 3h2v2H5zm0 4h2v2H5zm0 4h2v2H5zm4-8h2v2H9zm0 4h2v2H9zm0 4h2v2H9z";

/** An open editor: a card, a lane title, the add-card form or the add-list form. */
interface EditSession {
  el: HTMLElement;
  editor: MountedEditor;
  /** Commit (true) or abandon (false). */
  close(save: boolean): void;
}

export class BoardView extends TextFileView {
  plugin: TodoBoardPlugin;
  board: Board | null = null;
  error: string | null = null;
  settings: Settings = DEFAULTS;
  /** The card editor that has focus (read by Obsidian's editor commands). */
  activeEditor: any = null;

  private history: string[] = [];
  private dnd: DragController;
  private renderer: Component | null = null;
  private renderSeq = 0;
  private pendingRender = false;
  private afterRender: Array<() => void> = [];
  private edit: EditSession | null = null;
  private searchQuery: string | null = null;
  private showArchive = false;
  private laneFormOpen = false;
  private confirm: { lane: number; action: LaneAction } | null = null;
  private headerButtons: HTMLElement[] = [];

  constructor(leaf: WorkspaceLeaf, plugin: TodoBoardPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.dnd = new DragController({
      root: () => this.rootEl(),
      onDragStart: () => this.edit?.close(true),
      onDrop: (r) => this.onDrop(r),
      onDragEnd: () => {
        if (this.pendingRender) this.render();
      },
    });
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "z", (evt) => {
      if (isTyping(evt)) return true;
      this.undo();
      return false;
    });
    this.scope.register(["Mod"], "f", (evt) => {
      if (isTyping(evt)) return true;
      this.openSearch();
      return false;
    });
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return this.file?.basename ?? "Board";
  }

  getIcon() {
    return "lucide-trello";
  }

  async onOpen() {
    this.registerDomEvent(this.containerEl.doc, "pointerdown", (e) => this.onPointerDownAnywhere(e), true);
    this.initHeaderButtons();
  }

  async onUnloadFile(file: TFile) {
    // Commit an open edit before TextFileView's final save, not after it.
    this.edit?.close(true);
    return super.onUnloadFile(file);
  }

  async onClose() {
    this.edit?.close(true);
    if (this.renderer) this.removeChild(this.renderer);
    this.renderer = null;
  }

  onPaneMenu(menu: Menu, source: string) {
    if (source === "more-options") {
      menu
        .addItem((item) =>
          item
            .setTitle("Open as markdown")
            .setIcon("lucide-file-text")
            .setSection("pane")
            .onClick(() => this.plugin.openAsMarkdown(this.leaf)),
        )
        .addItem((item) =>
          item
            .setTitle("Open board settings")
            .setIcon("lucide-settings")
            .setSection("pane")
            .onClick(() => this.openSettings()),
        )
        .addItem((item) =>
          item
            .setTitle("Archive completed cards")
            .setIcon("lucide-archive")
            .setSection("pane")
            .onClick(() => this.archiveCompleted()),
        )
        .addItem((item) =>
          item
            .setTitle(this.showArchive ? "Hide archive" : "Show archive")
            .setIcon("lucide-library")
            .setSection("pane")
            .onClick(() => this.toggleArchive()),
        );
    }
    super.onPaneMenu(menu, source);
  }

  /** The header buttons obsidian-kanban shows by default (it hides them all on phones). */
  private initHeaderButtons() {
    if (Platform.isPhone) return;
    this.headerButtons.forEach((b) => b.remove());
    // addAction prepends, so these appear right to left, in obsidian-kanban's order.
    this.headerButtons = [
      this.addAction("lucide-settings", "Open board settings", () => this.openSettings()),
      this.addAction("lucide-search", "Search...", () => this.openSearch()),
      this.addAction("lucide-file-text", "Open as markdown", () => this.plugin.openAsMarkdown(this.leaf)),
      this.addAction("lucide-archive", "Archive completed cards", () => this.archiveCompleted()),
      this.addAction("lucide-plus-circle", "Add a list", () => {
        this.laneFormOpen = true;
        this.render();
      }),
    ];
    this.headerButtons.at(-1)!.addClass(c("ignore-click-outside"));
  }

  openSettings() {
    if (!this.board) return;
    new BoardSettingsModal(this.app, this.settings, (patch) => this.mutate((board) => updateSettings(board, patch))).open();
  }

  // ------------------------------------------------------------ file plumbing

  getViewData(): string {
    // Always the text we were given or last wrote: opening a board never rewrites it.
    return this.data;
  }

  setViewData(data: string, clear: boolean): void {
    if (clear || data !== this.data) this.history = [];
    if (clear) {
      this.searchQuery = null;
      this.showArchive = false;
      this.laneFormOpen = false;
      this.confirm = null;
    }
    this.data = data;
    this.parseData(data);
    this.render();
  }

  clear(): void {
    this.edit?.close(false);
    this.board = null;
    this.error = null;
    this.history = [];
  }

  private parseData(data: string) {
    try {
      this.board = parseBoard(data);
      this.error = null;
      this.settings = resolveSettings(this.plugin.globalSettings, this.board.settings);
    } catch (e) {
      this.board = null;
      this.error = e instanceof BoardParseError ? e.message : String(e);
    }
  }

  /** Apply a change to the board, save it, and (by default) redraw. */
  mutate(fn: (board: Board) => void, redraw = true) {
    if (!this.board) return;
    this.history.push(this.data);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    fn(this.board);
    this.data = serializeBoard(this.board);
    this.settings = resolveSettings(this.plugin.globalSettings, this.board.settings);
    this.requestSave();
    if (redraw) this.render();
  }

  undo() {
    const prev = this.history.pop();
    if (prev === undefined) {
      new Notice("Nothing to undo");
      return;
    }
    this.edit?.close(false);
    this.data = prev;
    this.parseData(prev);
    this.requestSave();
    this.render();
  }

  // ------------------------------------------------------------ finding cards

  private cards(board: Board, place: Place): Card[] {
    if (place === "archive") return (board.archive ??= []);
    return board.lanes[place]?.cards ?? [];
  }

  /**
   * Find a card again by its text, in case the file changed (Sync, an edit in
   * another pane) between showing it and acting on it.
   */
  private locate(ref: CardRef, md: string): CardRef | null {
    const board = this.board;
    if (!board) return null;
    if (cardToMd(this.cards(board, ref.place)[ref.index] ?? { check: null, title: "\0", rest: [] }) === md) return ref;
    const places: Place[] = [ref.place, ...board.lanes.map((_, i) => i).filter((i) => i !== ref.place), "archive"];
    for (const place of places) {
      const index = this.cards(board, place).findIndex((card) => cardToMd(card) === md);
      if (index !== -1) return { place, index };
    }
    return null;
  }

  private withCard(ref: CardRef, md: string, fn: (board: Board, ref: CardRef) => void, redraw = true) {
    const found = this.locate(ref, md);
    if (!found) {
      new Notice("That card has changed since; nothing was done.");
      this.render();
      return;
    }
    this.mutate((board) => fn(board, found), redraw);
  }

  /** Completion follows the lane, as in obsidian-kanban: into a Complete lane ticks, out of one unticks. */
  private settle(card: Card, from: Lane | null, to: Lane) {
    if (card.check === null) return;
    if (to.complete) card.check = "x";
    else if ((from === null || from.complete) && card.check === "x") card.check = " ";
  }

  moveCard(from: CardRef, md: string, toLane: number, toIndex: number) {
    this.withCard(from, md, (board, ref) => {
      const [card] = this.cards(board, ref.place).splice(ref.index, 1);
      const fromLane = ref.place === "archive" ? null : board.lanes[ref.place];
      const target = board.lanes[toLane];
      this.settle(card, fromLane, target);
      target.cards.splice(Math.min(toIndex, target.cards.length), 0, card);
    });
  }

  private moveLane(from: number, to: number) {
    if (from === to) return;
    this.mutate((board) => {
      const [lane] = board.lanes.splice(from, 1);
      board.lanes.splice(to, 0, lane);
      const collapse = this.collapseState(board);
      const [state] = collapse.splice(from, 1);
      collapse.splice(to, 0, state);
      if (board.settings["list-collapse"]) updateSettings(board, { "list-collapse": collapse });
    });
  }

  private collapseState(board: Board): boolean[] {
    const cur = (board.settings["list-collapse"] as boolean[] | undefined) ?? [];
    return board.lanes.map((_, i) => !!cur[i]);
  }

  archiveCompleted() {
    this.mutate((board) => {
      const archived: Card[] = [];
      for (const lane of board.lanes) {
        lane.cards = lane.cards.filter((card) => {
          const done = lane.complete || card.check === "x";
          if (done) archived.push(card);
          return !done;
        });
      }
      (board.archive ??= []).push(...archived);
    });
  }

  // ------------------------------------------------------------ rendering

  private rootEl(): HTMLElement | null {
    return this.contentEl.querySelector<HTMLElement>(":scope > .kanban-plugin");
  }

  async render() {
    if (this.dnd.active || this.edit) {
      this.pendingRender = true;
      return;
    }
    this.pendingRender = false;
    const seq = ++this.renderSeq;

    const renderer = new Component();
    renderer.load();
    const jobs: Promise<unknown>[] = [];
    const root = createDiv("kanban-plugin");

    if (this.error) {
      this.renderError(root);
    } else if (this.board) {
      root.style.setProperty("--lane-width", `${this.settings["lane-width"]}px`);
      this.renderBoard(root, this.board, renderer, jobs);
    }

    await Promise.all(jobs);
    if (seq !== this.renderSeq) return renderer.unload();
    if (this.dnd.active || this.edit) {
      renderer.unload();
      this.pendingRender = true;
      return;
    }

    const scroll = this.saveScroll();
    if (this.renderer) this.removeChild(this.renderer);
    this.addChild(renderer);
    this.renderer = renderer;
    this.contentEl.empty();
    this.contentEl.appendChild(root);
    this.restoreScroll(scroll);
    if (this.searchQuery !== null) this.applySearch();

    for (const fn of this.afterRender.splice(0)) fn();
  }

  private renderError(root: HTMLElement) {
    const box = root.createDiv("tb-error");
    box.createEl("h3", { text: "This board couldn't be read" });
    box.createEl("p", { text: this.error ?? "" });
    box.createEl("p", { text: "Nothing has been changed. Open it as markdown to fix the file by hand." });
    const btn = box.createEl("button", { text: "Open as markdown", cls: "mod-cta" });
    btn.onclick = () => this.plugin.openAsMarkdown(this.leaf);
  }

  private saveScroll() {
    const board = this.rootEl()?.querySelector<HTMLElement>(`.${c("board")}`);
    const lanes = Array.from(this.contentEl.querySelectorAll<HTMLElement>(`.${c("lane-items")}`));
    return { left: board?.scrollLeft ?? 0, top: board?.scrollTop ?? 0, lanes: lanes.map((l) => l.scrollTop) };
  }

  private restoreScroll(s: { left: number; top: number; lanes: number[] }) {
    const board = this.rootEl()?.querySelector<HTMLElement>(`.${c("board")}`);
    if (board) {
      board.scrollLeft = s.left;
      board.scrollTop = s.top;
    }
    this.contentEl.querySelectorAll<HTMLElement>(`.${c("lane-items")}`).forEach((l, i) => {
      l.scrollTop = s.lanes[i] ?? 0;
    });
  }

  private renderBoard(root: HTMLElement, board: Board, renderer: Component, jobs: Promise<unknown>[]) {
    if (this.searchQuery !== null) this.renderSearch(root);
    if (this.laneFormOpen || board.lanes.length === 0) this.renderLaneForm(root);

    const boardEl = root.createDiv(`${c("board")} ${c("horizontal")} ${c("scroll-container")}`);
    const inner = boardEl.createDiv();
    const collapse = this.collapseState(board);
    board.lanes.forEach((lane, i) => this.renderLane(inner, lane, i, collapse[i], renderer, jobs));
    if (this.showArchive) this.renderArchive(inner, board.archive ?? [], renderer, jobs);
    inner.createDiv({ cls: `${c("placeholder")} ${c("lane-placeholder")}`, attr: { "data-axis": "horizontal" } });
  }

  private markdown(parent: HTMLElement, md: string, renderer: Component, jobs: Promise<unknown>[], extraCls = "") {
    const wrapper = parent.createDiv(`${c("markdown-preview-wrapper")}${extraCls ? " " + extraCls : ""}`);
    const preview = wrapper.createDiv(`markdown-preview-view markdown-rendered ${c("markdown-preview-view")}`);
    jobs.push(MarkdownRenderer.render(this.app, md, preview, this.file?.path ?? "", renderer));
    return preview;
  }

  private renderLane(
    parent: HTMLElement,
    lane: Lane,
    laneIndex: number,
    collapsed: boolean,
    renderer: Component,
    jobs: Promise<unknown>[],
  ) {
    const wrapper = parent.createDiv(c("lane-wrapper"));
    wrapper.toggleClass("collapse-horizontal", collapsed);
    wrapper.dataset.collapsed = String(collapsed);
    const laneEl = wrapper.createDiv({ cls: c("lane"), attr: { "data-count": String(lane.cards.length) } });

    // Header: grip, collapse chevron, title, (count), menu.
    const header = laneEl.createDiv(c("lane-header-wrapper"));
    const grip = header.createDiv(c("lane-grip"));
    grip.createSvg("svg", { attr: { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 16 16" } }, (svg) =>
      svg.createSvg("path", { attr: { fill: "currentColor", d: GRIP_PATH } }),
    );
    const collapseBtn = header.createDiv(c("lane-collapse"));
    icon(collapseBtn, "chevron-down");
    collapseBtn.onclick = () => this.toggleCollapse(laneIndex);

    const titleEl = header.createDiv(c("lane-title"));
    const titleText = titleEl.createDiv(c("lane-title-text"));
    this.markdown(titleText, lane.title, renderer, jobs);
    header.addEventListener("dblclick", (e) => {
      if (collapsed || (e.target as HTMLElement).closest(`.${c("lane-settings-button-wrapper")}, .${c("lane-grip")}`)) return;
      this.editLaneTitle(titleEl, laneIndex, lane.title, { x: e.clientX, y: e.clientY });
    });

    if (!this.settings["hide-card-count"]) header.createDiv({ cls: c("lane-title-count"), text: String(lane.cards.length) });

    const buttons = header.createDiv(c("lane-settings-button-wrapper"));
    const menuBtn = buttons.createEl("a", { cls: `${c("lane-settings-button")} clickable-icon`, attr: { "aria-label": "More options" } });
    icon(menuBtn, "lucide-more-vertical");
    menuBtn.onclick = (e) => this.laneMenu(e, laneIndex);

    if (this.confirm?.lane === laneIndex) this.renderConfirm(laneEl, laneIndex, this.confirm.action);

    // Cards, then the placeholder obsidian-kanban keeps at the end (an empty lane shows it dashed).
    const items = laneEl.createDiv(`${c("lane-items")} ${c("vertical")} ${c("scroll-container")}`);
    lane.cards.forEach((card) => this.renderCard(items, card, lane, renderer, jobs));
    items.createDiv({ cls: c("placeholder"), attr: { "data-axis": "vertical" } });

    this.renderAddButton(laneEl, laneIndex);
    this.dnd.bind(grip, wrapper, "lane");
  }

  private renderArchive(parent: HTMLElement, archive: Card[], renderer: Component, jobs: Promise<unknown>[]) {
    const wrapper = parent.createDiv(`${c("lane-wrapper")} tb-archive-lane`);
    const laneEl = wrapper.createDiv({ cls: c("lane"), attr: { "data-count": String(archive.length) } });
    const header = laneEl.createDiv(c("lane-header-wrapper"));
    const title = header.createDiv(c("lane-title")).createDiv(c("lane-title-text"));
    this.markdown(title, `Archive (${archive.length})`, renderer, jobs);
    const buttons = header.createDiv(c("lane-settings-button-wrapper"));
    const close = buttons.createEl("a", { cls: `${c("lane-settings-button")} clickable-icon`, attr: { "aria-label": "Hide archive" } });
    icon(close, "lucide-x");
    close.onclick = () => this.toggleArchive();
    const items = laneEl.createDiv(`${c("lane-items")} ${c("vertical")} ${c("scroll-container")}`);
    archive.forEach((card) => this.renderCard(items, card, null, renderer, jobs));
    items.createDiv({ cls: c("placeholder"), attr: { "data-axis": "vertical" } });
  }

  private toggleArchive() {
    this.showArchive = !this.showArchive;
    if (this.showArchive) {
      this.afterRender.push(() => {
        const board = this.rootEl()?.querySelector(`.${c("board")}`);
        board?.scrollTo({ left: board.scrollWidth, behavior: "smooth" });
      });
    }
    this.render();
  }

  private toggleCollapse(laneIndex: number) {
    this.mutate((board) => {
      const collapse = this.collapseState(board);
      collapse[laneIndex] = !collapse[laneIndex];
      updateSettings(board, { "list-collapse": collapse });
    });
  }

  /** Index of an element among its siblings of the same class: the live position, not a stale one. */
  private refOf(itemWrapper: HTMLElement): CardRef | null {
    const laneWrapper = itemWrapper.closest<HTMLElement>(`.${c("lane-wrapper")}`);
    if (!laneWrapper) return null;
    const index = Array.from(itemWrapper.parentElement!.querySelectorAll(`:scope > .${c("item-wrapper")}`)).indexOf(itemWrapper);
    if (laneWrapper.hasClass("tb-archive-lane")) return { place: "archive", index };
    const lanes = Array.from(this.contentEl.querySelectorAll(`.${c("lane-wrapper")}:not(.tb-archive-lane)`));
    return { place: lanes.indexOf(laneWrapper), index };
  }

  private renderCard(items: HTMLElement, card: Card, lane: Lane | null, renderer: Component, jobs: Promise<unknown>[], before?: Element | null) {
    const md = cardToMd(card);
    const display = cardDisplay(card, { moveTags: this.settings["move-tags"] });

    const wrapper = createDiv(c("item-wrapper"));
    items.insertBefore(wrapper, before ?? items.querySelector(`:scope > .${c("placeholder")}`));
    wrapper.dataset.md = md;

    const item = wrapper.createDiv(c("item"));
    if (card.check === "x") item.addClass("is-complete");
    for (const tag of display.tags) item.addClass(`has-tag-${tag.slice(1)}`);
    if (display.dates.length) {
      const d = (moment as any)(display.dates[0], "YYYY-MM-DD");
      const today = (moment as any)().startOf("day");
      item.addClass(d.isSame(today, "day") ? "is-today" : d.isAfter(today, "day") ? "is-future" : "is-past");
    }

    const content = item.createDiv(c("item-content-wrapper"));
    const titleWrapper = content.createDiv(c("item-title-wrapper"));

    // Prefix: a checkbox when show-checkboxes is on, otherwise an archive button in Complete lanes.
    if (this.settings["show-checkboxes"] && card.check !== null) {
      const prefix = titleWrapper.createDiv(c("item-prefix-button-wrapper"));
      const box = prefix.createEl("input", { type: "checkbox", cls: "task-list-item-checkbox" });
      box.checked = card.check !== " ";
      box.dataset.task = card.check;
      box.onclick = (e) => {
        e.preventDefault();
        this.withCard(this.refOf(wrapper)!, md, (board, ref) => {
          const target = this.cards(board, ref.place)[ref.index];
          target.check = target.check === " " ? "x" : " ";
        });
      };
    } else if (lane?.complete) {
      const prefix = titleWrapper.createDiv(c("item-prefix-button-wrapper"));
      const btn = prefix.createEl("a", { cls: `${c("item-prefix-button")} clickable-icon`, attr: { "aria-label": "Archive card" } });
      icon(btn, "sheets-in-box");
      btn.onclick = () => this.archiveCard(this.refOf(wrapper)!, md);
    }

    const title = titleWrapper.createDiv(c("item-title"));
    const preview = this.markdown(title, display.markdown, renderer, jobs, c("item-markdown"));
    const metadata = title.createDiv(c("item-metadata"));
    if (this.settings["move-tags"] && display.tags.length) {
      const tagsEl = metadata.createDiv(c("item-tags"));
      for (const tag of display.tags) {
        const a = tagsEl.createEl("a", { cls: `tag ${c("item-tag")} `, attr: { href: tag } });
        a.createSpan({ text: tag[0] });
        a.appendText(tag.slice(1));
        const color = this.tagColor(tag);
        if (color?.color) a.style.setProperty("--tag-color", color.color);
        if (color?.backgroundColor) a.style.setProperty("--tag-background", color.backgroundColor);
        a.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.onTagClick(tag);
        };
      }
    }

    const postfix = titleWrapper.createDiv(c("item-postfix-button-wrapper"));
    const more = postfix.createEl("a", {
      cls: `${c("item-postfix-button")} clickable-icon`,
      attr: { "data-ignore-drag": "true", "aria-label": "More options" },
    });
    icon(more, "lucide-more-vertical");
    more.addEventListener("pointerdown", (e) => e.preventDefault());
    more.onclick = (e) => this.cardMenu(e, wrapper, card, md);

    // Clicks inside the card's text: sub-task checkboxes, links, times and dates.
    title.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const box = target.closest<HTMLInputElement>("input.task-list-item-checkbox");
      if (box && preview.contains(box) && !box.closest(".markdown-embed")) {
        e.preventDefault();
        e.stopPropagation();
        const n = Array.from(preview.querySelectorAll("input.task-list-item-checkbox")).indexOf(box);
        this.withCard(this.refOf(wrapper)!, md, (board, ref) => toggleSubtask(this.cards(board, ref.place)[ref.index], n));
        return;
      }
      const link = target.closest<HTMLAnchorElement>("a.internal-link");
      if (link) {
        e.preventDefault();
        const href = link.getAttribute("data-href") ?? link.getAttribute("href") ?? "";
        this.app.workspace.openLinkText(href, this.file?.path ?? "", Keymap.isModEvent(e));
        return;
      }
      if (target.hasClass(c("item-metadata-date"))) {
        this.dateMenu(e, wrapper, md, target.textContent ?? undefined);
        return;
      }
      if (target.hasClass(c("item-metadata-time"))) {
        const n = Array.from(preview.querySelectorAll(`.${c("item-metadata-time")}`)).indexOf(target);
        this.timePicker(e, wrapper, md, n, target.textContent ?? undefined);
      }
    });
    title.addEventListener("mouseover", (e) => {
      const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.internal-link");
      if (!link) return;
      this.app.workspace.trigger("hover-link", {
        event: e,
        source: VIEW_TYPE,
        hoverParent: this,
        targetEl: link,
        linktext: link.getAttribute("data-href") ?? link.getAttribute("href"),
        sourcePath: this.file?.path,
      });
    });

    content.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest("a, input, .cm-editor")) return;
      this.editCard(wrapper, card, md, { x: e.clientX, y: e.clientY });
    });
    content.addEventListener("contextmenu", (e) => {
      if (wrapper.hasClass("is-editing")) return;
      const link = (e.target as HTMLElement).closest("a.internal-link, a.external-link");
      if (link) return;
      e.preventDefault();
      this.cardMenu(e, wrapper, card, md);
    });

    if (lane) this.dnd.bind(wrapper, wrapper, "card");
    return wrapper;
  }

  private renderAddButton(laneEl: HTMLElement, laneIndex: number) {
    const wrap = laneEl.createDiv(c("item-button-wrapper"));
    const btn = wrap.createEl("button", { cls: c("new-item-button") });
    btn.createSpan({ cls: c("item-button-plus"), text: "+" });
    btn.appendText(" Add a card");
    btn.onclick = () => this.openAddForm(laneIndex);
  }

  private renderConfirm(laneEl: HTMLElement, laneIndex: number, action: LaneAction) {
    const box = laneEl.createDiv(c("action-confirm-wrapper"));
    box.createDiv({ cls: c("action-confirm-text"), text: CONFIRM[action].text });
    const row = box.createDiv();
    const yes = row.createEl("button", { cls: c("confirm-action-button"), text: CONFIRM[action].button });
    const no = row.createEl("button", { cls: c("cancel-action-button"), text: "Cancel" });
    no.onclick = () => {
      this.confirm = null;
      this.render();
    };
    yes.onclick = () => {
      this.confirm = null;
      this.runLaneAction(laneIndex, action);
    };
  }

  private runLaneAction(laneIndex: number, action: LaneAction) {
    this.mutate((board) => {
      const lane = board.lanes[laneIndex];
      if (action === "archive-items" || action === "archive") (board.archive ??= []).unshift(...lane.cards);
      if (action === "archive-items") lane.cards = [];
      else {
        board.lanes.splice(laneIndex, 1);
        const collapse = this.collapseState(board);
        collapse.splice(laneIndex, 1);
        if (board.settings["list-collapse"]) updateSettings(board, { "list-collapse": collapse });
      }
    });
  }

  // ------------------------------------------------------------ editing

  /** Clicking outside an open editor commits it (menus, suggestions and pickers excepted). */
  private onPointerDownAnywhere(e: PointerEvent) {
    const edit = this.edit;
    if (!edit) return;
    const t = e.target as HTMLElement;
    if (edit.el.contains(t)) return;
    if (t.closest(`.suggestion-container, .menu, .mobile-toolbar, .modal-container, .${c("ignore-click-outside")}, .${c("time-picker")}`)) return;
    edit.close(true);
  }

  private openEditor(el: HTMLElement, editor: MountedEditor, close: (save: boolean) => void): EditSession {
    this.edit?.close(true);
    let closed = false;
    const session: EditSession = {
      el,
      editor,
      close: (save) => {
        if (closed) return;
        closed = true;
        if (this.edit === session) this.edit = null;
        close(save);
      },
    };
    this.edit = session;
    return session;
  }

  /** Swap a card's content for Obsidian's editor. */
  editCard(wrapper: HTMLElement, card: Card, md: string, cursorAt?: { x: number; y: number }) {
    const ref = this.refOf(wrapper);
    if (!ref) return;
    const titleWrapper = wrapper.querySelector<HTMLElement>(`.${c("item-title-wrapper")}`)!;
    const content = wrapper.querySelector<HTMLElement>(`.${c("item-content-wrapper")}`)!;
    const titleEl = titleWrapper.querySelector<HTMLElement>(`.${c("item-title")}`)!;
    const postfix = titleWrapper.querySelector<HTMLElement>(`.${c("item-postfix-button-wrapper")}`)!;

    wrapper.addClass("is-editing");
    content.dataset.ignoreDrag = "true";
    titleWrapper.dataset.ignoreDrag = "true";
    titleEl.hide();
    const inputWrapper = createDiv(c("item-input-wrapper"));
    titleWrapper.insertBefore(inputWrapper, postfix);

    // While editing, the menu button becomes "cancel".
    const moreBtn = postfix.querySelector<HTMLElement>("a")!;
    moreBtn.hide();
    const cancel = postfix.createEl("a", {
      cls: `${c("item-postfix-button")} is-enabled clickable-icon`,
      attr: { "data-ignore-drag": "true", "aria-label": "Cancel" },
    });
    icon(cancel, "lucide-x");
    cancel.addEventListener("pointerdown", (e) => e.preventDefault());

    const original = cardText(card);
    const editor = mountEditor(this, inputWrapper, {
      value: original,
      cls: c("item-input"),
      cursorAt,
      onEnter: (_cm, mod, shift) => {
        if (allowNewLine(this.settings["new-line-trigger"], mod, shift)) return false;
        session.close(true);
        return true;
      },
      onEscape: () => session.close(true),
      onSubmit: () => session.close(true),
    });

    const session = this.openEditor(wrapper, editor, (save) => {
      const text = editor.value().trim();
      editor.destroy();
      if (save && text !== original.trim()) {
        if (!text) {
          this.withCard(ref, md, (board, r) => this.cards(board, r.place).splice(r.index, 1));
        } else {
          this.withCard(ref, md, (board, r) => setCardText(this.cards(board, r.place)[r.index], text));
        }
      } else if (!original.trim()) {
        // An inserted card that never got any text.
        this.withCard(ref, md, (board, r) => this.cards(board, r.place).splice(r.index, 1));
      } else {
        this.render();
      }
    });
    cancel.onclick = () => session.close(false);
  }

  private openAddForm(laneIndex: number) {
    const laneEl = this.contentEl.querySelectorAll<HTMLElement>(`.${c("lane-wrapper")}:not(.tb-archive-lane) .${c("lane")}`)[laneIndex];
    const buttonWrap = laneEl?.querySelector<HTMLElement>(`:scope > .${c("item-button-wrapper")}`);
    if (!laneEl || !buttonWrap) return;

    const form = createDiv(c("item-form"));
    laneEl.insertBefore(form, buttonWrap);
    buttonWrap.hide();
    const inputWrapper = form.createDiv(c("item-input-wrapper"));

    const add = (text: string) => {
      if (!text.trim()) return;
      const before = this.board!.lanes[laneIndex].cards.length;
      this.mutate((board) => {
        const lane = board.lanes[laneIndex];
        lane.cards.push(newCard(text.trim(), lane.complete));
      }, false);
      // Show the new card in place, keeping the form (and the keyboard) where they are.
      const lane = this.board!.lanes[laneIndex];
      const items = laneEl.querySelector<HTMLElement>(`.${c("lane-items")}`)!;
      const renderer = this.renderer ?? this.addChild(new Component());
      const card = lane.cards[before];
      if (card) this.renderCard(items, card, lane, renderer, []);
      laneEl.dataset.count = String(lane.cards.length);
      items.scrollTop = items.scrollHeight;
      editor.setValue("");
    };

    const editor = mountEditor(this, inputWrapper, {
      value: "",
      cls: c("item-input"),
      placeholder: "Card title...",
      onEnter: (cm, mod, shift) => {
        if (allowNewLine(this.settings["new-line-trigger"], mod, shift)) return false;
        add(cm.state.doc.toString());
        return true;
      },
      onEscape: (cm) => {
        add(cm.state.doc.toString());
        session.close(false);
      },
      onSubmit: (cm) => add(cm.state.doc.toString()),
    });

    const session = this.openEditor(form, editor, (save) => {
      if (save) add(editor.value());
      editor.destroy();
      form.remove();
      buttonWrap.show();
      if (this.pendingRender) this.render();
    });
  }

  private editLaneTitle(titleEl: HTMLElement, laneIndex: number, original: string, cursorAt?: { x: number; y: number }) {
    const text = titleEl.querySelector<HTMLElement>(`.${c("lane-title-text")}`);
    text?.hide();
    const editor = mountEditor(this, titleEl, {
      value: original,
      cls: c("lane-input"),
      cursorAt,
      onEnter: (_cm, mod, shift) => {
        if (allowNewLine(this.settings["new-line-trigger"], mod, shift)) return false;
        session.close(true);
        return true;
      },
      onEscape: () => session.close(true),
      onSubmit: () => session.close(true),
    });
    const session = this.openEditor(titleEl, editor, (save) => {
      const value = editor.value().replace(/\s*\n\s*/g, " ").trim();
      editor.destroy();
      if (save && value !== original) {
        this.mutate((board) => {
          if (board.lanes[laneIndex]?.title === original) board.lanes[laneIndex].title = value;
        });
      } else {
        this.render();
      }
    });
  }

  /** obsidian-kanban's "Add a list" form, top right of the board. */
  private renderLaneForm(root: HTMLElement) {
    const form = root.createDiv(c("lane-form-wrapper"));
    const inputWrapper = form.createDiv(c("lane-input-wrapper"));
    let complete = false;
    const check = form.createDiv(c("checkbox-wrapper"));
    check.createDiv({ cls: c("checkbox-label"), text: "Mark cards in this list as complete" });
    const toggle = check.createDiv("checkbox-container");
    toggle.onclick = () => {
      complete = !complete;
      toggle.toggleClass("is-enabled", complete);
    };
    const actions = form.createDiv(c("lane-input-actions"));
    const addBtn = actions.createEl("button", { cls: c("lane-action-add"), text: "Add list" });
    const doneBtn = actions.createEl("button", { cls: c("lane-action-cancel"), text: "Done" });

    // The editor needs to be in the document, so mount it once the board is
    // (and not at all if this draw was superseded by a newer one).
    this.afterRender.push(() => {
      if (!form.isConnected) return;
      const create = (title: string) => {
        if (!title.trim()) return;
        this.mutate((board) => board.lanes.push({ title: title.trim(), complete, cards: [] }), false);
        session.close(true);
      };
      const editor = mountEditor(this, inputWrapper, {
        value: "",
        cls: c("lane-input"),
        onEnter: (cm, mod, shift) => {
          if (allowNewLine(this.settings["new-line-trigger"], mod, shift)) return false;
          create(cm.state.doc.toString());
          return true;
        },
        onEscape: () => session.close(false),
        onSubmit: (cm) => create(cm.state.doc.toString()),
      });
      const session = this.openEditor(form, editor, () => {
        editor.destroy();
        this.laneFormOpen = false;
        this.render();
      });
      addBtn.onclick = () => create(editor.value());
      doneBtn.onclick = () => session.close(false);
    });
  }

  // ------------------------------------------------------------ search

  openSearch() {
    const focus = () => this.contentEl.querySelector<HTMLInputElement>(`.${c("filter-input")}`)?.focus();
    if (this.searchQuery !== null) return focus();
    this.searchQuery = "";
    this.afterRender.push(focus);
    this.render();
  }

  private closeSearch() {
    this.searchQuery = null;
    this.render();
  }

  private renderSearch(root: HTMLElement) {
    const wrap = root.createDiv(c("search-wrapper"));
    const input = wrap.createEl("input", {
      type: "text",
      cls: c("filter-input"),
      attr: { placeholder: "Search..." },
    });
    input.value = this.searchQuery ?? "";
    input.addEventListener("input", () => {
      this.searchQuery = input.value;
      this.applySearch();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeSearch();
      }
    });
    const cancel = wrap.createEl("a", { cls: `${c("search-cancel-button")} clickable-icon`, attr: { "aria-label": "Cancel" } });
    icon(cancel, "lucide-x");
    cancel.onclick = () => this.closeSearch();
  }

  /** Filter in place (no redraw, so typing isn't interrupted); empty lanes fold away. */
  private applySearch() {
    const q = (this.searchQuery ?? "").trim().toLowerCase();
    const root = this.rootEl();
    if (!root) return;
    root.toggleClass("tb-searching", !!q);
    root.querySelectorAll<HTMLElement>(`.${c("lane-wrapper")}`).forEach((laneWrapper) => {
      let any = false;
      laneWrapper.querySelectorAll<HTMLElement>(`.${c("item-wrapper")}`).forEach((w) => {
        const hit = !q || (w.dataset.md ?? "").toLowerCase().includes(q);
        w.toggleClass("tb-search-hidden", !hit);
        any ||= hit;
        w.querySelectorAll<HTMLElement>(`.${c("item-tag")}`).forEach((t) =>
          t.toggleClass("is-search-match", !!q && (t.textContent ?? "").toLowerCase().includes(q)),
        );
      });
      const userCollapsed = laneWrapper.dataset.collapsed === "true";
      laneWrapper.toggleClass("collapse-horizontal", userCollapsed || (!!q && !any));
    });
  }

  private onTagClick(tag: string) {
    if (this.settings["tag-action"] === "kanban") {
      this.searchQuery = tag;
      this.render();
      return;
    }
    (this.app as any).internalPlugins?.getPluginById?.("global-search")?.instance?.openGlobalSearch?.(`tag:${tag}`);
  }

  // ------------------------------------------------------------ menus

  private archiveCard(ref: CardRef, md: string) {
    this.withCard(ref, md, (board, r) => {
      const [card] = this.cards(board, r.place).splice(r.index, 1);
      (board.archive ??= []).push(card);
    });
  }

  private cardMenu(e: MouseEvent, wrapper: HTMLElement, card: Card, md: string) {
    const ref = this.refOf(wrapper);
    const board = this.board;
    if (!ref || !board) return;
    const menu = new Menu();
    const display = cardDisplay(card);

    if (ref.place === "archive") {
      board.lanes.forEach((lane, i) =>
        menu.addItem((item) =>
          item
            .setTitle(`Restore to ${lane.title}`)
            .setIcon("lucide-undo-2")
            .onClick(() => this.moveCard(ref, md, i, 0)),
        ),
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle("Delete card")
          .setIcon("lucide-trash-2")
          .onClick(() => this.withCard(ref, md, (b, r) => this.cards(b, r.place).splice(r.index, 1))),
      );
      menu.showAtMouseEvent(e);
      return;
    }

    const laneIndex = ref.place;
    const insertAt = (offset: number) => {
      const at = ref.index + offset;
      this.afterRender.push(() => this.editCardAt(laneIndex, at));
      this.withCard(ref, md, (b, r) => {
        const lane = b.lanes[r.place as number];
        lane.cards.splice(r.index + offset, 0, newCard("", lane.complete));
      });
    };

    menu.addItem((item) =>
      item
        .setTitle("Edit card")
        .setIcon("lucide-edit")
        .onClick(() => this.editCard(wrapper, card, md)),
    );
    menu.addSeparator();
    if (card.rest.length) {
      menu.addItem((item) =>
        item
          .setTitle("Split card")
          .setIcon("lucide-wrap-text")
          .onClick(() =>
            this.withCard(ref, md, (b, r) => {
              const lane = b.lanes[r.place as number];
              const lines = cardText(card)
                .split(/\n+/)
                .map((l) => l.trim())
                .filter(Boolean);
              lane.cards.splice(r.index, 1, ...lines.map((l) => newCard(l.replace(/^- (\[.\] )?/, ""), lane.complete)));
            }),
          ),
      );
    }
    menu
      .addItem((item) =>
        item
          .setTitle("Duplicate card")
          .setIcon("lucide-copy")
          .onClick(() =>
            this.withCard(ref, md, (b, r) => {
              const lane = b.lanes[r.place as number];
              lane.cards.splice(r.index + 1, 0, { ...lane.cards[r.index], rest: [...lane.cards[r.index].rest] });
            }),
          ),
      )
      .addItem((item) => item.setTitle("Insert card before").setIcon("lucide-list-start").onClick(() => insertAt(0)))
      .addItem((item) => item.setTitle("Insert card after").setIcon("lucide-list-end").onClick(() => insertAt(1)))
      .addItem((item) =>
        item
          .setTitle("Move to top")
          .setIcon("lucide-arrow-up")
          .onClick(() => this.moveCard(ref, md, laneIndex, 0)),
      )
      .addItem((item) =>
        item
          .setTitle("Move to bottom")
          .setIcon("lucide-arrow-down")
          .onClick(() => this.moveCard(ref, md, laneIndex, Number.MAX_SAFE_INTEGER)),
      )
      .addItem((item) =>
        item
          .setTitle("Archive card")
          .setIcon("lucide-archive")
          .onClick(() => this.archiveCard(ref, md)),
      )
      .addItem((item) =>
        item
          .setTitle("Delete card")
          .setIcon("lucide-trash-2")
          .onClick(() => this.withCard(ref, md, (b, r) => this.cards(b, r.place).splice(r.index, 1))),
      )
      .addSeparator();

    const hasDate = display.dates.length > 0;
    menu.addItem((item) =>
      item
        .setTitle(hasDate ? "Edit date" : "Add date")
        .setIcon("lucide-calendar-check")
        .onClick(() => this.dateMenu(e, wrapper, md, display.dates[0])),
    );
    if (hasDate) {
      menu.addItem((item) =>
        item
          .setTitle("Remove date")
          .setIcon("lucide-x")
          .onClick(() => this.withCard(ref, md, (b, r) => setCardDate(this.cards(b, r.place)[r.index], null))),
      );
    }
    const hasTime = display.times.length > 0;
    menu.addItem((item) =>
      item
        .setTitle(hasTime ? "Edit time" : "Add time")
        .setIcon("lucide-clock")
        .onClick(() => this.timePicker(e, wrapper, md, 0, display.times[0])),
    );
    if (hasTime) {
      menu.addItem((item) =>
        item
          .setTitle("Remove time")
          .setIcon("lucide-x")
          .onClick(() =>
            this.withCard(ref, md, (b, r) => {
              const target = this.cards(b, r.place)[r.index];
              for (let i = cardDisplay(target).times.length - 1; i >= 0; i--) setCardTime(target, i, null);
            }),
          ),
      );
    }
    menu.addSeparator();

    const addMoveTo = (m: Menu) => {
      if (board.lanes.length <= 1) return;
      board.lanes.forEach((lane, i) =>
        m.addItem((item) =>
          item
            .setIcon("lucide-square-kanban")
            .setChecked(i === laneIndex)
            .setTitle(lane.title)
            .onClick(() => {
              if (i !== laneIndex) this.moveCard(ref, md, i, 0);
            }),
        ),
      );
    };
    if (Platform.isPhone) addMoveTo(menu);
    else menu.addItem((item) => addMoveTo((item as any).setTitle("Move to list").setIcon("lucide-square-kanban").setSubmenu()));

    menu.showAtMouseEvent(e);
  }

  private editCardAt(laneIndex: number, index: number) {
    const lane = this.contentEl.querySelectorAll(`.${c("lane-wrapper")}:not(.tb-archive-lane)`)[laneIndex];
    const wrapper = lane?.querySelectorAll<HTMLElement>(`.${c("item-wrapper")}`)[index];
    const card = this.board?.lanes[laneIndex]?.cards[index];
    if (wrapper && card) this.editCard(wrapper, card, cardToMd(card));
  }

  private laneMenu(e: MouseEvent, laneIndex: number) {
    const ask = (action: LaneAction) => {
      if (!this.board!.lanes[laneIndex].cards.length) return this.runLaneAction(laneIndex, action);
      this.confirm = { lane: laneIndex, action };
      this.render();
    };
    const insertLane = (at: number) => {
      this.afterRender.push(() => {
        const titleEl = this.contentEl.querySelectorAll<HTMLElement>(`.${c("lane-wrapper")}:not(.tb-archive-lane) .${c("lane-title")}`)[at];
        if (titleEl) this.editLaneTitle(titleEl, at, "");
      });
      this.mutate((board) => {
        board.lanes.splice(at, 0, { title: "", complete: false, cards: [] });
        const collapse = this.collapseState(board);
        collapse.splice(at, 0, false);
        if (board.settings["list-collapse"]) updateSettings(board, { "list-collapse": collapse.slice(0, board.lanes.length) });
      });
    };

    new Menu()
      .addItem((item) =>
        item
          .setIcon("lucide-edit-3")
          .setTitle("Edit list")
          .onClick(() => {
            const titleEl = this.contentEl.querySelectorAll<HTMLElement>(`.${c("lane-wrapper")}:not(.tb-archive-lane) .${c("lane-title")}`)[laneIndex];
            if (titleEl) this.editLaneTitle(titleEl, laneIndex, this.board!.lanes[laneIndex].title);
          }),
      )
      .addItem((item) => item.setIcon("lucide-archive").setTitle("Archive cards").onClick(() => ask("archive-items")))
      .addSeparator()
      .addItem((item) => item.setIcon("arrow-left-to-line").setTitle("Insert list before").onClick(() => insertLane(laneIndex)))
      .addItem((item) => item.setIcon("arrow-right-to-line").setTitle("Insert list after").onClick(() => insertLane(laneIndex + 1)))
      .addSeparator()
      .addItem((item) => item.setIcon("lucide-archive").setTitle("Archive list").onClick(() => ask("archive")))
      .addItem((item) => item.setIcon("lucide-trash-2").setTitle("Delete list").onClick(() => ask("delete")))
      .showAtMouseEvent(e);
  }

  /** Pick a date for a card: the coming week, or remove it. */
  private dateMenu(e: MouseEvent, wrapper: HTMLElement, md: string, current?: string) {
    const ref = this.refOf(wrapper);
    if (!ref) return;
    const format = this.settings["date-format"];
    const today = (moment as any)().startOf("day");
    const set = (value: string | null) => this.withCard(ref, md, (b, r) => setCardDate(this.cards(b, r.place)[r.index], value));
    const menu = new Menu();
    for (let i = 0; i < 8; i++) {
      const d = today.clone().add(i, "day");
      const value = d.format(format);
      const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.format("dddd");
      menu.addItem((item) =>
        item
          .setTitle(`${label}  ·  ${d.format("MMM D")}`)
          .setIcon("lucide-calendar")
          .setChecked(value === current)
          .onClick(() => set(value)),
      );
    }
    if (current) {
      menu.addSeparator();
      menu.addItem((item) => item.setTitle("Remove date").setIcon("lucide-x").onClick(() => set(null)));
    }
    menu.showAtMouseEvent(e);
  }

  /** obsidian-kanban's time picker: a scrolling list of quarter hours. */
  private timePicker(e: MouseEvent, wrapper: HTMLElement, md: string, timeIndex: number, current?: string) {
    const ref = this.refOf(wrapper);
    if (!ref) return;
    const doc = this.containerEl.doc;
    doc.querySelector(`.${c("time-picker")}`)?.remove();
    const picker = doc.body.createDiv(`${c("time-picker")} ${c("ignore-click-outside")}`);
    picker.style.left = `${e.clientX}px`;
    picker.style.top = `${e.clientY}px`;

    let selected: HTMLElement | null = null;
    for (let h = 0; h < 24; h++) {
      for (const mm of [0, 15, 30, 45]) {
        const value = `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
        const item = picker.createDiv({ cls: c("time-picker-item"), attr: { "data-value": value } });
        if (mm === 0) item.addClass("is-hour");
        icon(item.createSpan(c("time-picker-check")), "lucide-check");
        item.appendText(value);
        if (value === current) {
          item.addClass("is-selected");
          selected = item;
        }
      }
    }

    const close = () => {
      picker.remove();
      doc.removeEventListener("pointerdown", outside, true);
      doc.removeEventListener("keydown", onKey, true);
    };
    const outside = (ev: PointerEvent) => {
      if (!picker.contains(ev.target as Node)) close();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close();
      }
    };
    picker.addEventListener("click", (ev) => {
      const item = (ev.target as HTMLElement).closest<HTMLElement>(`.${c("time-picker-item")}`);
      if (!item?.dataset.value) return;
      close();
      this.withCard(ref, md, (b, r) => setCardTime(this.cards(b, r.place)[r.index], timeIndex, item.dataset.value!));
    });
    doc.addEventListener("pointerdown", outside, true);
    doc.addEventListener("keydown", onKey, true);

    // Keep it on screen, then show the current (or next) time.
    const r = picker.getBoundingClientRect();
    if (r.bottom > doc.documentElement.clientHeight) picker.style.top = `${Math.max(0, e.clientY - r.height)}px`;
    if (r.right > doc.documentElement.clientWidth) picker.style.left = `${Math.max(0, e.clientX - r.width)}px`;
    const now = (moment as any)();
    const target = selected ?? picker.querySelector<HTMLElement>(`[data-value="${now.format("HH")}:00"]`);
    if (target) picker.scrollTop = target.offsetTop - 4;
  }

  // ------------------------------------------------------------ drag and drop

  private onDrop(r: DropResult) {
    if (!r.el.isConnected) return;
    if (r.kind === "lane") {
      const lanes = Array.from(this.contentEl.querySelectorAll(`.${c("lane-wrapper")}:not(.tb-archive-lane)`));
      const from = lanes.indexOf(r.el);
      if (from !== -1) this.moveLane(from, r.index);
      return;
    }
    const ref = this.refOf(r.el);
    const md = r.el.dataset.md;
    if (!ref || md === undefined) return;
    if (ref.place === r.lane && ref.index === r.index) return;
    this.moveCard(ref, md, r.lane, r.index);
  }

  // ------------------------------------------------------------ tags

  tagColor(tag: string): TagColor | undefined {
    const key = tag.toLowerCase();
    return this.settings["tag-colors"].find((t) => t.tagKey.toLowerCase() === key);
  }

  /** Tags on this board with how often they're used, coloured ones first. */
  boardTags(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const t of this.settings["tag-colors"]) counts.set(t.tagKey, 0);
    const cards = [...(this.board?.lanes.flatMap((l) => l.cards) ?? []), ...(this.board?.archive ?? [])];
    for (const card of cards) {
      for (const tag of cardDisplay(card).tags) {
        const key = [...counts.keys()].find((k) => k.toLowerCase() === tag.toLowerCase()) ?? tag;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return new Map([...counts].sort((a, b) => b[1] - a[1]));
  }
}

function icon(parent: HTMLElement, name: string): HTMLElement {
  const span = parent.createSpan({ cls: `${c("icon")} `, attr: { "data-icon": name } });
  setIcon(span, name);
  return span;
}

function isTyping(evt: KeyboardEvent) {
  const t = evt.target as HTMLElement | null;
  return !!t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable || !!t.closest?.(".cm-editor"));
}
