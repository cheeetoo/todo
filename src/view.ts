import {
  Component,
  Keymap,
  MarkdownRenderer,
  Menu,
  Notice,
  Platform,
  Scope,
  TextFileView,
  moment,
  setIcon,
  type TFile,
  type WorkspaceLeaf,
} from "obsidian";
import { DragController, type DropResult } from "./dnd";
import { allowNewLine, mountEditor, type MountedEditor } from "./editor";
import { KeysModal } from "./keys";
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
import { TagColorsModal } from "./tagColors";

export const VIEW_TYPE = "todo-board";
export const DATE_FORMAT = "YYYY-MM-DD";

/** obsidian-kanban's class names, so its stylesheet (and any theme styling it) applies as-is. */
const c = (cls: string) => `kanban-plugin__${cls}`;

/**
 * A card's lane and position. The file may still hold obsidian-kanban's
 * archive section; it's kept as-is but never shown or searched.
 */
export interface CardRef {
  place: number;
  index: number;
}

type LaneAction = "clear" | "delete";
const CONFIRM: Record<LaneAction, { text: string; button: string }> = {
  clear: { text: "Are you sure you want to delete all cards in this list?", button: "Yes, delete cards" },
  delete: { text: "Are you sure you want to delete this list and all its cards?", button: "Yes, delete list" },
};

const HISTORY_LIMIT = 100;
const GRIP_PATH = "M5 3h2v2H5zm0 4h2v2H5zm0 4h2v2H5zm4-8h2v2H9zm0 4h2v2H9zm0 4h2v2H9z";

/** Where the keyboard is: a lane and a card in it (index -1 in a lane with no cards). */
interface Cursor {
  lane: number;
  index: number;
}

type Direction = "up" | "down" | "left" | "right";
const DIRECTIONS: Record<string, Direction> = {
  j: "down",
  arrowdown: "down",
  k: "up",
  arrowup: "up",
  h: "left",
  arrowleft: "left",
  l: "right",
  arrowright: "right",
};
/** The list the keys start in, by title. */
const DEFAULT_LANE = "today";
/** How long "g" or "d" waits for its second press. */
const CHORD_MS = 1000;

/** An open editor: a card, a lane title, or one of the add forms. */
interface EditSession {
  el: HTMLElement;
  /** Commit (true) or abandon (false). */
  close(save: boolean): void;
}

export class BoardView extends TextFileView {
  plugin: TodoBoardPlugin;
  board: Board | null = null;
  error: string | null = null;
  /** The card editor that has focus (Obsidian's editor commands read it). */
  activeEditor: unknown = null;

  private history: string[] = [];
  private dnd: DragController;
  private renderer: Component | null = null;
  private renderSeq = 0;
  /** A redraw was asked for while an edit or a drag was in progress. */
  private pendingRender = false;
  private edit: EditSession | null = null;
  private searchQuery: string | null = null;
  private focusSearch = false;
  private laneFormOpen = false;
  private confirm: { lane: number; action: LaneAction } | null = null;
  /** The card the keyboard is on; kept in step with the board, and redrawn after every render. */
  private cursor: Cursor | null = null;
  /** The first key of a two-key command (gg, dd), waiting for its second. */
  private chord: { key: string; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: TodoBoardPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.dnd = new DragController({
      root: () => this.rootEl(),
      onDragStart: () => this.edit?.close(true),
      onDrop: (r) => this.onDrop(r),
      onDragEnd: () => this.pendingRender && this.render(),
    });
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "z", (evt) => (isTyping(evt) ? true : (this.undo(), false)));
    this.scope.register(["Mod"], "f", (evt) => (isTyping(evt) ? true : (this.openSearch(), false)));
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
    this.registerDomEvent(
      this.containerEl.doc,
      "keydown",
      (e) => {
        if (this.app.workspace.getActiveViewOfType(BoardView) !== this || !this.onKey(e)) return;
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );
    // obsidian-kanban's header buttons, which it leaves off on phones. addAction
    // prepends, so these appear right to left.
    if (Platform.isPhone) return;
    this.addAction("lucide-settings", "Tag colours", () => this.openTagColors());
    this.addAction("lucide-search", "Search...", () => this.openSearch());
    this.addAction("lucide-file-text", "Open as markdown", () => this.plugin.openAsMarkdown(this.leaf));
    this.addAction("lucide-archive", "Clear completed cards", () => this.clearCompleted());
    this.addAction("lucide-plus-circle", "Add a list", () => {
      this.laneFormOpen = true;
      this.render();
    }).addClass(c("ignore-click-outside"));
  }

  async onUnloadFile(file: TFile) {
    // Commit an open edit before TextFileView's final save, not after it.
    this.edit?.close(true);
    return super.onUnloadFile(file);
  }

  onPaneMenu(menu: Menu, source: string) {
    if (source === "more-options") {
      for (const [title, icon, run] of [
        ["Open as markdown", "lucide-file-text", () => this.plugin.openAsMarkdown(this.leaf)],
        ["Tag colours", "lucide-settings", () => this.openTagColors()],
        ["Clear completed cards", "lucide-archive", () => this.clearCompleted()],
      ] as const)
        menu.addItem((item) => item.setTitle(title).setIcon(icon).setSection("pane").onClick(run));
    }
    super.onPaneMenu(menu, source);
  }

  private openTagColors() {
    if (!this.board) return;
    new TagColorsModal(this.app, this.tagColors(), (colors) =>
      // tag-sort is obsidian-kanban's tag order; keep it in step.
      this.mutate((board) =>
        updateSettings(board, { "tag-colors": colors, "tag-sort": colors.map((t) => ({ tag: t.tagKey })) }),
      ),
    ).open();
  }

  // ------------------------------------------------------------ file plumbing

  getViewData(): string {
    // The text we were given or last wrote: opening a board never rewrites it.
    return this.data;
  }

  setViewData(data: string, clear: boolean): void {
    if (clear || data !== this.data) this.history = [];
    if (clear) {
      this.searchQuery = null;
      this.laneFormOpen = false;
      this.confirm = null;
      this.cursor = null;
    }
    this.data = data;
    this.parse(data);
    this.render();
  }

  clear(): void {
    this.edit?.close(false);
    this.board = null;
    this.error = null;
    this.history = [];
    this.cursor = null;
  }

  private parse(data: string) {
    try {
      this.board = parseBoard(data);
      this.error = null;
    } catch (e) {
      this.board = null;
      this.error = e instanceof BoardParseError ? e.message : String(e);
    }
  }

  /** Change the board, save it, and (by default) redraw. */
  private mutate(fn: (board: Board) => void, redraw = true) {
    if (!this.board) return;
    this.history.push(this.data);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    fn(this.board);
    this.data = serializeBoard(this.board);
    this.requestSave();
    if (redraw) this.render();
  }

  undo() {
    const prev = this.history.pop();
    if (prev === undefined) return new Notice("Nothing to undo");
    this.edit?.close(false);
    this.data = prev;
    this.parse(prev);
    this.requestSave();
    this.render();
  }

  // ------------------------------------------------------------ changes

  private cards(board: Board, lane: number): Card[] {
    return board.lanes[lane]?.cards ?? [];
  }

  /**
   * Find a card again by its text, in case the file changed (Sync, another
   * pane) between drawing it and acting on it.
   */
  private locate(ref: CardRef, md: string): CardRef | null {
    const board = this.board!;
    const at = this.cards(board, ref.place)[ref.index];
    if (at && cardToMd(at) === md) return ref;
    const lanes = [ref.place, ...board.lanes.map((_, i) => i).filter((i) => i !== ref.place)];
    for (const place of lanes) {
      const index = this.cards(board, place).findIndex((card) => cardToMd(card) === md);
      if (index !== -1) return { place, index };
    }
    return null;
  }

  private withCard(ref: CardRef, md: string, fn: (card: Card, cards: Card[], index: number) => void) {
    const found = this.board && this.locate(ref, md);
    if (!found) {
      new Notice("That card has changed since; nothing was done.");
      return this.render();
    }
    this.mutate((board) => {
      const cards = this.cards(board, found.place);
      fn(cards[found.index], cards, found.index);
    });
  }

  moveCard(from: CardRef, md: string, toLane: number, toIndex: number) {
    const found = this.board && this.locate(from, md);
    if (!found) return this.render();
    this.mutate((board) => {
      const source = board.lanes[found.place];
      const target = board.lanes[toLane];
      const [card] = source.cards.splice(found.index, 1);
      // As in obsidian-kanban: into a Complete lane ticks a card, out of one unticks it.
      if (card.check !== null) {
        if (target.complete) card.check = "x";
        else if (source.complete && card.check === "x") card.check = " ";
      }
      target.cards.splice(Math.min(toIndex, target.cards.length), 0, card);
    });
  }

  deleteCard(ref: CardRef, md: string) {
    this.withCard(ref, md, (_card, cards, index) => cards.splice(index, 1));
  }

  /** Delete what's done: every card in a Complete lane, and any ticked card. */
  clearCompleted() {
    this.mutate((board) => {
      for (const lane of board.lanes) lane.cards = lane.cards.filter((card) => !lane.complete && card.check !== "x");
    });
  }

  private collapsed(board: Board): boolean[] {
    const saved = board.settings["list-collapse"] ?? [];
    return board.lanes.map((_, i) => !!saved[i]);
  }

  toggleCollapse(lane: number) {
    this.mutate((board) => {
      const collapse = this.collapsed(board);
      collapse[lane] = !collapse[lane];
      updateSettings(board, { "list-collapse": collapse });
    });
  }

  /** Reorder or remove lanes, keeping list-collapse lined up with them. */
  private changeLanes(fn: (lanes: { lane: Lane; collapsed: boolean }[]) => void) {
    this.mutate((board) => {
      const collapse = this.collapsed(board);
      const rows = board.lanes.map((lane, i) => ({ lane, collapsed: collapse[i] }));
      fn(rows);
      board.lanes = rows.map((r) => r.lane);
      if (board.settings["list-collapse"]) updateSettings(board, { "list-collapse": rows.map((r) => r.collapsed) });
    });
  }

  moveLane(from: number, to: number) {
    if (from !== to) this.changeLanes((rows) => rows.splice(to, 0, ...rows.splice(from, 1)));
  }

  private runLaneAction(lane: number, action: LaneAction) {
    if (action === "clear") this.mutate((board) => (board.lanes[lane].cards = []));
    else this.changeLanes((rows) => rows.splice(lane, 1));
  }

  // ------------------------------------------------------------ rendering

  private rootEl(): HTMLElement | null {
    return this.contentEl.querySelector<HTMLElement>(":scope > .kanban-plugin");
  }

  /** Build the whole board off-screen, wait for its markdown, then swap it in. */
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
    if (this.error) this.renderError(root);
    else if (this.board) this.renderBoard(root, this.board, renderer, jobs);

    await Promise.all(jobs);
    if (seq !== this.renderSeq || this.dnd.active || this.edit) {
      renderer.unload();
      if (seq === this.renderSeq) this.pendingRender = true;
      return;
    }

    const scroll = this.saveScroll();
    if (this.renderer) this.removeChild(this.renderer);
    this.renderer = this.addChild(renderer);
    this.contentEl.empty();
    this.contentEl.appendChild(root);
    this.restoreScroll(scroll);
    this.paintCursor();

    if (this.searchQuery !== null) this.applySearch();
    if (this.focusSearch) root.querySelector<HTMLInputElement>(`.${c("filter-input")}`)?.focus();
    this.focusSearch = false;
    const laneForm = root.querySelector<HTMLElement>(`.${c("lane-form-wrapper")}`);
    if (laneForm) this.openLaneForm(laneForm);
  }

  private renderError(root: HTMLElement) {
    const box = root.createDiv("tb-error");
    box.createEl("h3", { text: "This board couldn't be read" });
    box.createEl("p", { text: this.error ?? "" });
    box.createEl("p", { text: "Nothing has been changed. Open it as markdown to fix the file by hand." });
    box.createEl("button", { text: "Open as markdown", cls: "mod-cta" }).onclick = () => this.plugin.openAsMarkdown(this.leaf);
  }

  private saveScroll() {
    const board = this.rootEl()?.querySelector<HTMLElement>(`.${c("board")}`);
    const lanes = Array.from(this.contentEl.querySelectorAll<HTMLElement>(`.${c("lane-items")}`));
    return { left: board?.scrollLeft ?? 0, lanes: lanes.map((l) => l.scrollTop) };
  }

  private restoreScroll(s: { left: number; lanes: number[] }) {
    const board = this.rootEl()?.querySelector<HTMLElement>(`.${c("board")}`);
    if (board) board.scrollLeft = s.left;
    this.contentEl.querySelectorAll<HTMLElement>(`.${c("lane-items")}`).forEach((l, i) => (l.scrollTop = s.lanes[i] ?? 0));
  }

  private renderBoard(root: HTMLElement, board: Board, renderer: Component, jobs: Promise<unknown>[]) {
    if (this.searchQuery !== null) this.renderSearch(root);
    if (this.laneFormOpen || board.lanes.length === 0) this.renderLaneForm(root);
    const inner = root.createDiv(`${c("board")} ${c("horizontal")} ${c("scroll-container")}`).createDiv();
    const collapse = this.collapsed(board);
    board.lanes.forEach((lane, i) => this.renderLane(inner, lane, i, collapse[i], renderer, jobs));
    inner.createDiv({ cls: `${c("placeholder")} ${c("lane-placeholder")}`, attr: { "data-axis": "horizontal" } });
  }

  private markdown(parent: HTMLElement, md: string, renderer: Component, jobs: Promise<unknown>[], extraCls = "") {
    const preview = parent
      .createDiv(`${c("markdown-preview-wrapper")} ${extraCls}`.trim())
      .createDiv(`markdown-preview-view markdown-rendered ${c("markdown-preview-view")}`);
    jobs.push(MarkdownRenderer.render(this.app, md, preview, this.file?.path ?? "", renderer));
    return preview;
  }

  private renderLane(parent: HTMLElement, lane: Lane, laneIndex: number, collapsed: boolean, renderer: Component, jobs: Promise<unknown>[]) {
    const wrapper = parent.createDiv(c("lane-wrapper"));
    wrapper.toggleClass("collapse-horizontal", collapsed);
    wrapper.dataset.collapsed = String(collapsed);
    const laneEl = wrapper.createDiv({ cls: c("lane"), attr: { "data-count": String(lane.cards.length) } });

    const header = laneEl.createDiv(c("lane-header-wrapper"));
    const grip = header.createDiv(c("lane-grip"));
    grip.createSvg("svg", { attr: { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 16 16" } }, (svg) =>
      svg.createSvg("path", { attr: { fill: "currentColor", d: GRIP_PATH } }),
    );
    icon(header.createDiv(c("lane-collapse")), "chevron-down").parentElement!.onclick = () => this.toggleCollapse(laneIndex);
    const titleEl = header.createDiv(c("lane-title"));
    this.markdown(titleEl.createDiv(c("lane-title-text")), lane.title, renderer, jobs);
    header.addEventListener("dblclick", (e) => {
      if (collapsed || (e.target as HTMLElement).closest(`.${c("lane-settings-button-wrapper")}, .${c("lane-grip")}`)) return;
      this.editLaneTitle(titleEl, laneIndex, lane.title, { x: e.clientX, y: e.clientY });
    });
    const menuBtn = header
      .createDiv(c("lane-settings-button-wrapper"))
      .createEl("a", { cls: `${c("lane-settings-button")} clickable-icon`, attr: { "aria-label": "More options" } });
    icon(menuBtn, "lucide-more-vertical");
    menuBtn.onclick = (e) => this.laneMenu(e, laneIndex, titleEl);

    if (this.confirm?.lane === laneIndex) this.renderConfirm(laneEl, laneIndex, this.confirm.action);

    // Cards, then the placeholder obsidian-kanban keeps at the end (an empty lane shows it dashed).
    const items = laneEl.createDiv(`${c("lane-items")} ${c("vertical")} ${c("scroll-container")}`);
    for (const card of lane.cards) this.renderCard(items, card, lane, renderer, jobs);
    items.createDiv({ cls: c("placeholder"), attr: { "data-axis": "vertical" } });

    const add = laneEl.createDiv(c("item-button-wrapper")).createEl("button", { cls: c("new-item-button") });
    add.createSpan({ cls: c("item-button-plus"), text: "+" });
    add.appendText(" Add a card");
    add.onclick = () => this.openAddForm(laneEl, laneIndex);

    this.dnd.bind(grip, wrapper, "lane");
  }

  /** A card's live position, read off the DOM (so cards added in place still resolve). */
  private refOf(itemWrapper: HTMLElement): CardRef {
    const laneWrapper = itemWrapper.closest(`.${c("lane-wrapper")}`)!;
    return {
      place: Array.from(this.contentEl.querySelectorAll(`.${c("lane-wrapper")}`)).indexOf(laneWrapper),
      index: Array.from(itemWrapper.parentElement!.querySelectorAll(`:scope > .${c("item-wrapper")}`)).indexOf(itemWrapper),
    };
  }

  private renderCard(items: HTMLElement, card: Card, lane: Lane, renderer: Component, jobs: Promise<unknown>[]) {
    const md = cardToMd(card);
    const display = cardDisplay(card, this.tagColors());
    const ref = () => this.refOf(wrapper);

    const wrapper = createDiv(c("item-wrapper"));
    items.insertBefore(wrapper, items.querySelector(`:scope > .${c("placeholder")}`));
    wrapper.dataset.md = md;

    const item = wrapper.createDiv(c("item"));
    if (card.check === "x") item.addClass("is-complete");
    for (const tag of display.tags) item.addClass(`has-tag-${tag.slice(1)}`);
    if (display.dates.length) {
      const diff = moment(display.dates[0], DATE_FORMAT).diff(moment().startOf("day"), "days");
      item.addClass(diff === 0 ? "is-today" : diff > 0 ? "is-future" : "is-past");
    }

    const content = item.createDiv(c("item-content-wrapper"));
    const titleWrapper = content.createDiv(c("item-title-wrapper"));

    // In Complete lanes, obsidian-kanban's archive button, which here clears the card away.
    if (lane.complete) {
      const btn = titleWrapper
        .createDiv(c("item-prefix-button-wrapper"))
        .createEl("a", { cls: `${c("item-prefix-button")} clickable-icon`, attr: { "aria-label": "Clear card" } });
      icon(btn, "sheets-in-box");
      btn.onclick = () => this.deleteCard(ref(), md);
    }

    const title = titleWrapper.createDiv(c("item-title"));
    const preview = this.markdown(title, display.markdown, renderer, jobs, c("item-markdown"));
    const tagsEl = title.createDiv(c("item-metadata")).createDiv(c("item-tags"));
    for (const tag of display.tags) {
      const a = tagsEl.createEl("a", { cls: `tag ${c("item-tag")} `, attr: { href: tag } });
      a.createSpan({ text: "#" });
      a.appendText(tag.slice(1));
      paintTag(a, this.tagColor(tag));
      a.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openSearch(tag);
      };
    }
    if (!display.tags.length) tagsEl.remove();

    const more = titleWrapper
      .createDiv(c("item-postfix-button-wrapper"))
      .createEl("a", { cls: `${c("item-postfix-button")} clickable-icon`, attr: { "data-ignore-drag": "true", "aria-label": "More options" } });
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
        return this.withCard(ref(), md, (card) => toggleSubtask(card, n));
      }
      const link = target.closest<HTMLAnchorElement>("a.internal-link");
      if (link) {
        e.preventDefault();
        this.app.workspace.openLinkText(link.dataset.href ?? link.getAttribute("href") ?? "", this.file?.path ?? "", Keymap.isModEvent(e));
      } else if (target.hasClass(c("item-metadata-date"))) {
        this.dateMenu(e, wrapper, md, target.textContent ?? undefined);
      } else if (target.hasClass(c("item-metadata-time"))) {
        const n = Array.from(preview.querySelectorAll(`.${c("item-metadata-time")}`)).indexOf(target);
        this.timePicker(e, wrapper, md, n, target.textContent ?? undefined);
      }
    });
    title.addEventListener("mouseover", (e) => {
      const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.internal-link");
      if (link)
        this.app.workspace.trigger("hover-link", {
          event: e,
          source: VIEW_TYPE,
          hoverParent: this,
          targetEl: link,
          linktext: link.dataset.href ?? link.getAttribute("href"),
          sourcePath: this.file?.path,
        });
    });

    content.addEventListener("dblclick", (e) => {
      if (!(e.target as HTMLElement).closest("a, input, .cm-editor")) this.editCard(wrapper, card, md, { x: e.clientX, y: e.clientY });
    });
    content.addEventListener("contextmenu", (e) => {
      if (wrapper.hasClass("is-editing") || (e.target as HTMLElement).closest("a.internal-link, a.external-link")) return;
      e.preventDefault();
      this.cardMenu(e, wrapper, card, md);
    });

    this.dnd.bind(wrapper, wrapper, "card");
  }

  private renderConfirm(laneEl: HTMLElement, lane: number, action: LaneAction) {
    const box = laneEl.createDiv(c("action-confirm-wrapper"));
    box.createDiv({ cls: c("action-confirm-text"), text: CONFIRM[action].text });
    const row = box.createDiv();
    row.createEl("button", { cls: c("confirm-action-button"), text: CONFIRM[action].button }).onclick = () => {
      this.confirm = null;
      this.runLaneAction(lane, action);
    };
    row.createEl("button", { cls: c("cancel-action-button"), text: "Cancel" }).onclick = () => {
      this.confirm = null;
      this.render();
    };
  }

  // ------------------------------------------------------------ editing

  /** Clicking outside an open editor commits it (menus, suggestions and pickers excepted). */
  private onPointerDownAnywhere(e: PointerEvent) {
    const t = e.target as HTMLElement;
    // Clicking a card puts the keyboard on it.
    const clicked = t.closest?.<HTMLElement>(`.${c("item-wrapper")}`);
    if (clicked && this.contentEl.contains(clicked) && !this.dnd.active) {
      const ref = this.refOf(clicked);
      this.cursor = { lane: ref.place, index: ref.index };
      this.paintCursor(false);
    }
    if (!this.edit || this.edit.el.contains(t)) return;
    if (t.closest(`.suggestion-container, .menu, .mobile-toolbar, .modal-container, .${c("ignore-click-outside")}`)) return;
    this.edit.close(true);
  }

  /** Mount Obsidian's editor in `parent`; `done` runs once, with what's typed and whether to keep it. */
  private openEditor(
    el: HTMLElement,
    parent: HTMLElement,
    opts: { value: string; cls: string; placeholder?: string; cursorAt?: { x: number; y: number }; onEnter?: (text: string) => void },
    done: (text: string, save: boolean) => void,
  ): MountedEditor {
    this.edit?.close(true);
    let closed = false;
    const close = (save: boolean) => {
      if (closed) return;
      closed = true;
      if (this.edit === session) this.edit = null;
      const text = editor.value();
      editor.destroy();
      done(text, save);
    };
    const session: EditSession = { el, close };
    // Enter submits (or, for the add form, adds and stays open); Shift+Enter is a new line.
    const submit = (text: string) => (opts.onEnter ? opts.onEnter(text) : close(true));
    const editor = mountEditor(this, parent, {
      ...opts,
      onEnter: (cm, mod, shift) => (allowNewLine(mod, shift) ? false : (submit(cm.state.doc.toString()), true)),
      // Reached only once vim (if on) is back in normal mode.
      onEscape: () => close(true),
      onSubmit: (cm) => submit(cm.state.doc.toString()),
    });
    this.edit = session;
    return editor;
  }

  editCard(wrapper: HTMLElement, card: Card, md: string, cursorAt?: { x: number; y: number }) {
    const ref = this.refOf(wrapper);
    this.cursor = { lane: ref.place, index: ref.index };
    const titleWrapper = wrapper.querySelector<HTMLElement>(`.${c("item-title-wrapper")}`)!;
    const postfix = titleWrapper.querySelector<HTMLElement>(`.${c("item-postfix-button-wrapper")}`)!;
    wrapper.addClass("is-editing");
    wrapper.querySelector<HTMLElement>(`.${c("item-content-wrapper")}`)!.dataset.ignoreDrag = "true";
    titleWrapper.querySelector<HTMLElement>(`.${c("item-title")}`)!.hide();
    const inputWrapper = createDiv(c("item-input-wrapper"));
    titleWrapper.insertBefore(inputWrapper, postfix);

    // While editing, the menu button becomes "cancel".
    postfix.querySelector("a")!.hide();
    const cancel = postfix.createEl("a", {
      cls: `${c("item-postfix-button")} is-enabled clickable-icon`,
      attr: { "data-ignore-drag": "true", "aria-label": "Cancel" },
    });
    icon(cancel, "lucide-x");
    cancel.addEventListener("pointerdown", (e) => e.preventDefault());

    const original = cardText(card);
    this.openEditor(wrapper, inputWrapper, { value: original, cls: c("item-input"), cursorAt }, (typed, save) => {
      const text = typed.trim();
      if (!save || text === original.trim()) return this.render();
      // Emptying a card deletes it.
      this.withCard(ref, md, (card, cards, index) => (text ? setCardText(card, text) : cards.splice(index, 1)));
    });
    cancel.onclick = () => this.edit?.close(false);
  }

  private openAddForm(laneEl: HTMLElement, laneIndex: number) {
    const button = laneEl.querySelector<HTMLElement>(`:scope > .${c("item-button-wrapper")}`)!;
    const form = createDiv(c("item-form"));
    laneEl.insertBefore(form, button);
    button.hide();

    const add = (text: string) => {
      if (!text.trim()) return;
      this.mutate((board) => {
        const lane = board.lanes[laneIndex];
        lane.cards.push(newCard(text.trim(), lane.complete));
      }, false);
      // Draw just the new card, keeping the form (and a phone's keyboard) where they are.
      const lane = this.board!.lanes[laneIndex];
      const items = laneEl.querySelector<HTMLElement>(`.${c("lane-items")}`)!;
      this.renderCard(items, lane.cards[lane.cards.length - 1], lane, this.renderer ?? this.addChild(new Component()), []);
      laneEl.dataset.count = String(lane.cards.length);
      items.scrollTop = items.scrollHeight;
      this.cursor = { lane: laneIndex, index: lane.cards.length - 1 };
      this.paintCursor(false);
      editor.setValue("");
    };

    const editor = this.openEditor(
      form,
      form.createDiv(c("item-input-wrapper")),
      { value: "", cls: c("item-input"), placeholder: "Card title...", onEnter: add },
      (text, save) => {
        if (save) add(text);
        form.remove();
        button.show();
        if (this.pendingRender) this.render();
      },
    );
  }

  private editLaneTitle(titleEl: HTMLElement, lane: number, original: string, cursorAt?: { x: number; y: number }) {
    titleEl.querySelector<HTMLElement>(`.${c("lane-title-text")}`)?.hide();
    this.openEditor(titleEl, titleEl, { value: original, cls: c("lane-input"), cursorAt }, (typed, save) => {
      const title = typed.replace(/\s*\n\s*/g, " ").trim();
      if (!save || title === original) return this.render();
      this.mutate((board) => {
        if (board.lanes[lane]?.title === original) board.lanes[lane].title = title;
      });
    });
  }

  /** obsidian-kanban's "Add a list" form, top right; the editor goes in once it's on screen. */
  private renderLaneForm(root: HTMLElement) {
    const form = root.createDiv(c("lane-form-wrapper"));
    form.createDiv(c("lane-input-wrapper"));
    const actions = form.createDiv(c("lane-input-actions"));
    actions.createEl("button", { cls: c("lane-action-add"), text: "Add list" });
    actions.createEl("button", { cls: c("lane-action-cancel"), text: "Done" });
  }

  private openLaneForm(form: HTMLElement) {
    const create = (title: string) => {
      if (title.trim()) this.mutate((board) => board.lanes.push({ title: title.trim(), complete: false, cards: [] }), false);
    };
    const editor = this.openEditor(
      form,
      form.querySelector<HTMLElement>(`.${c("lane-input-wrapper")}`)!,
      { value: "", cls: c("lane-input"), onEnter: (text) => this.edit?.close(true) },
      (text, save) => {
        if (save) create(text);
        this.laneFormOpen = false;
        this.render();
      },
    );
    const [addBtn, doneBtn] = Array.from(form.querySelectorAll("button"));
    addBtn.onclick = () => (create(editor.value()), this.edit?.close(false));
    doneBtn.onclick = () => this.edit?.close(false);
  }

  // ------------------------------------------------------------ search

  openSearch(query = "") {
    if (this.searchQuery !== null && !query) {
      this.rootEl()?.querySelector<HTMLInputElement>(`.${c("filter-input")}`)?.focus();
      return;
    }
    this.searchQuery = query;
    this.focusSearch = true;
    this.render();
  }

  private renderSearch(root: HTMLElement) {
    const wrap = root.createDiv(c("search-wrapper"));
    const input = wrap.createEl("input", { type: "text", cls: c("filter-input"), attr: { placeholder: "Search..." } });
    input.value = this.searchQuery ?? "";
    input.addEventListener("input", () => {
      this.searchQuery = input.value;
      this.applySearch();
    });
    const close = () => {
      this.searchQuery = null;
      this.render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Enter") {
        // Done typing: land on the first match so j/k carry on from there.
        e.preventDefault();
        input.blur();
        this.cursor = null;
        this.startCursor();
      }
    });
    const cancel = wrap.createEl("a", { cls: `${c("search-cancel-button")} clickable-icon`, attr: { "aria-label": "Cancel" } });
    icon(cancel, "lucide-x");
    cancel.onclick = close;
  }

  /** Filter in place (no redraw, so typing isn't interrupted); lanes with no matches fold away. */
  private applySearch() {
    const q = (this.searchQuery ?? "").trim().toLowerCase();
    const root = this.rootEl();
    if (!root) return;
    root.toggleClass("tb-searching", !!q);
    for (const laneWrapper of Array.from(root.querySelectorAll<HTMLElement>(`.${c("lane-wrapper")}`))) {
      let any = false;
      for (const w of Array.from(laneWrapper.querySelectorAll<HTMLElement>(`.${c("item-wrapper")}`))) {
        const hit = !q || (w.dataset.md ?? "").toLowerCase().includes(q);
        w.toggleClass("tb-search-hidden", !hit);
        any ||= hit;
      }
      laneWrapper.toggleClass("collapse-horizontal", laneWrapper.dataset.collapsed === "true" || (!!q && !any));
    }
  }

  // ------------------------------------------------------------ keyboard

  /**
   * vim-style keys for the board. Returns whether the key was used. Nothing
   * happens while typing in an editor or the search box, or with a menu or
   * dialog open.
   */
  onKey(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
    if (!this.board || this.edit || this.dnd.active || isTyping(e)) return false;
    if (this.containerEl.doc.querySelector(`.modal-container, .menu, .${c("time-picker")}`)) return false;
    const pending = this.chord?.key;
    this.clearChord();
    this.clampCursor();

    const key = e.key;
    const dir = DIRECTIONS[key.toLowerCase()];
    if (dir) {
      // Capital letters (by case, so Caps Lock agrees) and Shift+arrows move the card.
      if (key.length === 1 ? key !== key.toLowerCase() : e.shiftKey) this.moveSelected(dir);
      else this.select(dir);
    } else if (key === "g") {
      if (pending === "g") this.select("top");
      else this.armChord(key);
    } else if (key === "G") this.select("bottom");
    else if (key === "d") {
      if (pending === "d") this.deleteSelected();
      else this.armChord(key);
    } else if (key === "Enter" || key === "e") {
      if (!this.editSelected()) return false;
    } else if (key === "a") {
      if (!this.addToSelectedLane()) return false;
    } else if (key === "u") this.undo();
    else if (key === "/") this.openSearch();
    else if (key === "?") new KeysModal(this.app).open();
    else if (key === "Escape" && this.cursor) {
      this.cursor = null;
      this.paintCursor();
    } else return false;
    return true;
  }

  private armChord(key: string) {
    this.chord = { key, timer: setTimeout(() => this.clearChord(), CHORD_MS) };
  }

  private clearChord() {
    if (this.chord) clearTimeout(this.chord.timer);
    this.chord = null;
  }

  private searchTerm(): string {
    return (this.searchQuery ?? "").trim().toLowerCase();
  }

  /** Whether a lane is on screen: not collapsed, and (while searching) holding a match. */
  private laneShown(lane: number): boolean {
    const board = this.board!;
    if (this.collapsed(board)[lane]) return false;
    return !this.searchTerm() || this.shownCards(lane).length > 0;
  }

  /** The positions of a lane's cards that are on screen (search hides the rest). */
  private shownCards(lane: number): number[] {
    const q = this.searchTerm();
    const out: number[] = [];
    this.cards(this.board!, lane).forEach((card, i) => {
      if (!q || cardToMd(card).toLowerCase().includes(q)) out.push(i);
    });
    return out;
  }

  /** The nearest lane in a direction that's on screen. */
  private neighbourLane(lane: number, step: 1 | -1): number | null {
    for (let i = lane + step; i >= 0 && i < this.board!.lanes.length; i += step) if (this.laneShown(i)) return i;
    return null;
  }

  /** The on-screen card closest to a position, or -1 if the lane shows none. */
  private nearestShown(lane: number, index: number): number {
    let best = -1;
    for (const i of this.shownCards(lane)) if (best === -1 || Math.abs(i - index) < Math.abs(best - index)) best = i;
    return best;
  }

  /** Keep the cursor on a card (or an empty lane) that exists. */
  private clampCursor() {
    const cur = this.cursor;
    if (!cur) return;
    const lanes = this.board?.lanes;
    if (!lanes?.length) {
      this.cursor = null;
      return;
    }
    cur.lane = Math.min(cur.lane, lanes.length - 1);
    const count = lanes[cur.lane].cards.length;
    cur.index = count ? Math.max(0, Math.min(cur.index, count - 1)) : -1;
  }

  /** Where the keys act before any card is selected: the Today list, else the first one on screen. */
  private defaultLane(): number {
    const lanes = this.board?.lanes ?? [];
    const today = lanes.findIndex((lane, i) => lane.title.trim().toLowerCase() === DEFAULT_LANE && this.laneShown(i));
    return today !== -1 ? today : lanes.findIndex((_, i) => this.laneShown(i));
  }

  /** The first press of any movement key just lands on the default list's first card. */
  private startCursor() {
    const lane = this.defaultLane();
    if (lane === -1) return;
    this.cursor = { lane, index: this.nearestShown(lane, 0) };
    this.paintCursor();
  }

  private select(dir: Direction | "top" | "bottom") {
    if (!this.cursor) return this.startCursor();
    const { lane, index } = this.cursor;
    if (dir === "left" || dir === "right") {
      const to = this.neighbourLane(lane, dir === "left" ? -1 : 1);
      if (to !== null) this.cursor = { lane: to, index: this.nearestShown(to, index) };
    } else {
      const shown = this.shownCards(lane);
      const to =
        dir === "top" ? shown[0] : dir === "bottom" ? shown[shown.length - 1] : dir === "down" ? shown.find((i) => i > index) : shown.filter((i) => i < index).pop();
      if (to !== undefined) this.cursor.index = to;
    }
    this.paintCursor();
  }

  /** Shift+direction: up/down reorders within the lane, left/right moves to the next lane (same row, if it has one). */
  private moveSelected(dir: Direction) {
    if (!this.cursor) return this.startCursor();
    const { lane, index } = this.cursor;
    if (index < 0) return;
    const ref = { place: lane, index };
    const md = cardToMd(this.board!.lanes[lane].cards[index]);
    let to: Cursor | undefined;
    if (dir === "left" || dir === "right") {
      const target = this.neighbourLane(lane, dir === "left" ? -1 : 1);
      if (target !== null) to = { lane: target, index: Math.min(index, this.board!.lanes[target].cards.length) };
    } else {
      const shown = this.shownCards(lane);
      const next = dir === "down" ? shown.find((i) => i > index) : shown.filter((i) => i < index).pop();
      if (next !== undefined) to = { lane, index: next };
    }
    if (!to) return;
    this.cursor = to;
    this.moveCard(ref, md, to.lane, to.index);
  }

  private deleteSelected() {
    const cur = this.cursor;
    if (!cur || cur.index < 0) return;
    this.deleteCard({ place: cur.lane, index: cur.index }, cardToMd(this.board!.lanes[cur.lane].cards[cur.index]));
    this.clampCursor();
  }

  private editSelected(): boolean {
    const cur = this.cursor;
    if (!cur || cur.index < 0) return false;
    const card = this.board!.lanes[cur.lane].cards[cur.index];
    const wrapper = this.cardEl(cur.lane, cur.index);
    // Not drawn yet (a redraw is under way): nothing to open the editor in.
    if (!wrapper || wrapper.dataset.md !== cardToMd(card)) return false;
    this.editCard(wrapper, card, cardToMd(card));
    return true;
  }

  private addToSelectedLane(): boolean {
    // With nothing selected, add to the default list (without selecting anything).
    const lane = this.cursor?.lane ?? this.defaultLane();
    if (lane === -1 || this.searchTerm() || !this.laneShown(lane)) return false;
    const laneEl = this.laneEl(lane)?.querySelector<HTMLElement>(`:scope > .${c("lane")}`);
    if (!laneEl) return false;
    this.openAddForm(laneEl, lane);
    return true;
  }

  private laneEl(lane: number): HTMLElement | undefined {
    return this.contentEl.querySelectorAll<HTMLElement>(`.${c("lane-wrapper")}`)[lane];
  }

  private cardEl(lane: number, index: number): HTMLElement | undefined {
    return this.laneEl(lane)?.querySelectorAll<HTMLElement>(`.${c("item-wrapper")}`)[index];
  }

  /** Outline the card the keyboard is on (or the lane, if it's empty). */
  private paintCursor(scroll = true) {
    this.contentEl.querySelectorAll(".tb-selected").forEach((el) => el.removeClass("tb-selected"));
    this.clampCursor();
    const cur = this.cursor;
    if (!cur) return;
    const el = cur.index >= 0 ? this.cardEl(cur.lane, cur.index) : this.laneEl(cur.lane)?.querySelector<HTMLElement>(`:scope > .${c("lane")}`);
    el?.addClass("tb-selected");
    if (scroll) el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  // ------------------------------------------------------------ menus and pickers

  private cardMenu(e: MouseEvent, wrapper: HTMLElement, card: Card, md: string) {
    const ref = this.refOf(wrapper);
    const board = this.board!;
    const { dates, times } = cardDisplay(card);
    const menu = new Menu();
    const item = (title: string, icon: string, run: () => void) => menu.addItem((i) => i.setTitle(title).setIcon(icon).onClick(run));

    item("Edit card", "lucide-edit", () => this.editCard(wrapper, card, md));
    menu.addSeparator();
    item("Move to top", "lucide-arrow-up", () => this.moveCard(ref, md, ref.place, 0));
    item("Move to bottom", "lucide-arrow-down", () => this.moveCard(ref, md, ref.place, Infinity));
    item("Delete card", "lucide-trash-2", () => this.deleteCard(ref, md));
    menu.addSeparator();
    item(dates.length ? "Edit date" : "Add date", "lucide-calendar-check", () => this.dateMenu(e, wrapper, md, dates[0]));
    if (dates.length) item("Remove date", "lucide-x", () => this.withCard(ref, md, (card) => setCardDate(card, null)));
    item(times.length ? "Edit time" : "Add time", "lucide-clock", () => this.timePicker(e, wrapper, md, 0, times[0]));
    if (times.length)
      item("Remove time", "lucide-x", () =>
        this.withCard(ref, md, (card) => {
          for (let i = times.length - 1; i >= 0; i--) setCardTime(card, i, null);
        }),
      );
    menu.addSeparator();

    const moveTo = (m: Menu) =>
      board.lanes.forEach((lane, i) =>
        m.addItem((it) =>
          it
            .setIcon("lucide-square-kanban")
            .setChecked(i === ref.place)
            .setTitle(lane.title)
            .onClick(() => i !== ref.place && this.moveCard(ref, md, i, 0)),
        ),
      );
    if (Platform.isPhone) moveTo(menu);
    else menu.addItem((it) => moveTo((it as any).setTitle("Move to list").setIcon("lucide-square-kanban").setSubmenu()));
    menu.showAtMouseEvent(e);
  }

  private laneMenu(e: MouseEvent, lane: number, titleEl: HTMLElement) {
    const ask = (action: LaneAction) => {
      if (!this.board!.lanes[lane].cards.length) return this.runLaneAction(lane, action);
      this.confirm = { lane, action };
      this.render();
    };
    new Menu()
      .addItem((i) =>
        i
          .setIcon("lucide-edit-3")
          .setTitle("Edit list")
          .onClick(() => this.editLaneTitle(titleEl, lane, this.board!.lanes[lane].title)),
      )
      .addItem((i) => i.setIcon("lucide-archive").setTitle("Clear cards").onClick(() => ask("clear")))
      .addItem((i) => i.setIcon("lucide-trash-2").setTitle("Delete list").onClick(() => ask("delete")))
      .showAtMouseEvent(e);
  }

  /** Pick a card's date from the coming week, or remove it. */
  private dateMenu(e: MouseEvent, wrapper: HTMLElement, md: string, current?: string) {
    const ref = this.refOf(wrapper);
    const set = (value: string | null) => this.withCard(ref, md, (card) => setCardDate(card, value));
    const menu = new Menu();
    for (let i = 0; i < 8; i++) {
      const d = moment().startOf("day").add(i, "days");
      const value = d.format(DATE_FORMAT);
      const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.format("dddd");
      menu.addItem((it) =>
        it
          .setTitle(`${label}  ·  ${d.format("MMM D")}`)
          .setIcon("lucide-calendar")
          .setChecked(value === current)
          .onClick(() => set(value)),
      );
    }
    if (current) menu.addSeparator().addItem((it) => it.setTitle("Remove date").setIcon("lucide-x").onClick(() => set(null)));
    menu.showAtMouseEvent(e);
  }

  /** obsidian-kanban's time picker: a scrolling list of quarter hours. */
  private timePicker(e: MouseEvent, wrapper: HTMLElement, md: string, timeIndex: number, current?: string) {
    const ref = this.refOf(wrapper);
    const doc = this.containerEl.doc;
    doc.querySelector(`.${c("time-picker")}`)?.remove();
    const picker = doc.body.createDiv(`${c("time-picker")} ${c("ignore-click-outside")}`);
    picker.style.left = `${e.clientX}px`;
    picker.style.top = `${e.clientY}px`;

    for (let m = 0; m < 24 * 60; m += 15) {
      const value = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      const row = picker.createDiv({ cls: c("time-picker-item"), attr: { "data-value": value } });
      row.toggleClass("is-hour", m % 60 === 0);
      row.toggleClass("is-selected", value === current);
      icon(row.createSpan(c("time-picker-check")), "lucide-check");
      row.appendText(value);
    }

    const close = () => {
      picker.remove();
      doc.removeEventListener("pointerdown", outside, true);
      doc.removeEventListener("keydown", onKey, true);
    };
    const outside = (ev: PointerEvent) => !picker.contains(ev.target as Node) && close();
    const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && (ev.preventDefault(), close());
    picker.addEventListener("click", (ev) => {
      const value = (ev.target as HTMLElement).closest<HTMLElement>(`.${c("time-picker-item")}`)?.dataset.value;
      if (!value) return;
      close();
      this.withCard(ref, md, (card) => setCardTime(card, timeIndex, value));
    });
    doc.addEventListener("pointerdown", outside, true);
    doc.addEventListener("keydown", onKey, true);

    // Keep it on screen, then scroll to the current time (or this hour).
    const r = picker.getBoundingClientRect();
    const { clientWidth, clientHeight } = doc.documentElement;
    if (r.bottom > clientHeight) picker.style.top = `${Math.max(0, e.clientY - r.height)}px`;
    if (r.right > clientWidth) picker.style.left = `${Math.max(0, e.clientX - r.width)}px`;
    const target =
      picker.querySelector<HTMLElement>(".is-selected") ?? picker.querySelector<HTMLElement>(`[data-value="${moment().format("HH")}:00"]`);
    if (target) picker.scrollTop = target.offsetTop - 4;
  }

  // ------------------------------------------------------------ drag and drop

  private onDrop(r: DropResult) {
    if (!r.el.isConnected) return;
    if (r.kind === "lane") {
      const from = Array.from(this.contentEl.querySelectorAll(`.${c("lane-wrapper")}`)).indexOf(r.el);
      if (from !== -1) this.moveLane(from, r.index);
      return;
    }
    const ref = this.refOf(r.el);
    if (ref.place !== r.lane || ref.index !== r.index) this.moveCard(ref, r.el.dataset.md!, r.lane, r.index);
  }

  // ------------------------------------------------------------ tags

  /** The board's tag colours (obsidian-kanban keeps them in its settings block). */
  private tagColors(): TagColor[] {
    return this.board?.settings["tag-colors"] ?? [];
  }

  tagColor(tag: string): TagColor | undefined {
    return this.tagColors().find((t) => t.tagKey.toLowerCase() === tag.toLowerCase());
  }

  /** Tags on this board (coloured ones first) with how often each is used. */
  boardTags(): Map<string, number> {
    const counts = new Map<string, number>(this.tagColors().map((t) => [t.tagKey, 0]));
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

export function paintTag(el: HTMLElement, color: TagColor | undefined) {
  if (color?.color) el.style.setProperty("--tag-color", color.color);
  if (color?.backgroundColor) el.style.setProperty("--tag-background", color.backgroundColor);
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
