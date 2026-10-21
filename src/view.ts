import {
  Component,
  Keymap,
  MarkdownRenderer,
  Menu,
  Notice,
  Scope,
  TextFileView,
  type WorkspaceLeaf,
  moment,
  setIcon,
} from "obsidian";
import type TodoBoardPlugin from "./main";
import {
  type Board,
  BoardParseError,
  type Card,
  type Lane,
  type TagColor,
  cardMeta,
  cardText,
  newCard,
  parseBoard,
  serializeBoard,
  setCardText,
  toggleSubtask,
} from "./parser";

export const VIEW_TYPE = "todo-board";

/** Where a card lives: a lane index, or "archive". */
type Place = number | "archive";
interface CardRef {
  place: Place;
  index: number;
}

const HISTORY_LIMIT = 100;

export class BoardView extends TextFileView {
  plugin: TodoBoardPlugin;
  board: Board | null = null;
  error: string | null = null;

  private history: string[] = [];
  private renderer: Component | null = null;
  private drag: CardRef | null = null;
  private dropIndicator: HTMLElement | null = null;
  private addingTo: number | null = null;
  private showArchive = false;
  private archiveAction: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: TodoBoardPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "z", (evt) => {
      if (isTyping(evt)) return true;
      this.undo();
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
    return "kanban";
  }

  async onOpen() {
    this.addAction("file-text", "Open as markdown", () => this.plugin.openAsMarkdown(this.leaf));
    this.archiveAction = this.addAction("archive", "Show archive", () => {
      this.showArchive = !this.showArchive;
      this.archiveAction?.toggleClass("is-active", this.showArchive);
      this.render();
      if (this.showArchive) {
        const board = this.contentEl.querySelector(".tb-board");
        board?.scrollTo({ left: board.scrollWidth, behavior: "smooth" });
      }
    });
  }

  async onClose() {
    this.renderer?.unload();
    this.renderer = null;
  }

  onPaneMenu(menu: Menu, source: string) {
    menu.addItem((item) =>
      item
        .setTitle("Open as markdown")
        .setIcon("file-text")
        .setSection("pane")
        .onClick(() => this.plugin.openAsMarkdown(this.leaf)),
    );
    super.onPaneMenu(menu, source);
  }

  // ---- TextFileView plumbing ----

  getViewData(): string {
    // Always the text we were given or last wrote, never a re-serialization of
    // an untouched file: opening the board must not rewrite anything.
    return this.data;
  }

  setViewData(data: string, clear: boolean): void {
    if (clear || data !== this.data) this.history = [];
    this.data = data;
    try {
      this.board = parseBoard(data);
      this.error = null;
    } catch (e) {
      this.board = null;
      this.error = e instanceof BoardParseError ? e.message : String(e);
    }
    this.render();
  }

  clear(): void {
    this.board = null;
    this.error = null;
    this.history = [];
    this.addingTo = null;
  }

  // ---- Changing the board ----

  private mutate(fn: (board: Board) => void) {
    if (!this.board) return;
    this.history.push(this.data);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    fn(this.board);
    this.data = serializeBoard(this.board);
    this.requestSave();
    this.render();
  }

  undo() {
    const prev = this.history.pop();
    if (prev === undefined) {
      new Notice("Nothing to undo");
      return;
    }
    this.data = prev;
    this.board = parseBoard(prev);
    this.requestSave();
    this.render();
  }

  private cards(board: Board, place: Place): Card[] {
    if (place === "archive") return (board.archive ??= []);
    return board.lanes[place].cards;
  }

  private moveCard(from: CardRef, toLane: number, toIndex: number) {
    this.mutate((board) => {
      const [card] = this.cards(board, from.place).splice(from.index, 1);
      const target = board.lanes[toLane];
      const fromLane = from.place === "archive" ? null : board.lanes[from.place];
      if (target.complete && card.check !== null) card.check = "x";
      else if (fromLane?.complete && !target.complete && card.check === "x") card.check = " ";
      else if (from.place === "archive" && card.check === "x") card.check = " ";
      target.cards.splice(Math.min(toIndex, target.cards.length), 0, card);
    });
  }

  private archiveCard(ref: CardRef) {
    this.mutate((board) => {
      const [card] = this.cards(board, ref.place).splice(ref.index, 1);
      (board.archive ??= []).unshift(card);
    });
  }

  private deleteCard(ref: CardRef) {
    this.mutate((board) => {
      this.cards(board, ref.place).splice(ref.index, 1);
    });
  }

  private archiveLane(laneIndex: number) {
    this.mutate((board) => {
      const lane = board.lanes[laneIndex];
      (board.archive ??= []).unshift(...lane.cards);
      lane.cards = [];
    });
  }

  // ---- Rendering ----

  render() {
    const root = this.contentEl;
    const scroll = this.saveScroll();

    this.renderer?.unload();
    this.renderer = new Component();
    this.renderer.load();
    root.empty();
    root.addClass("tb-view");

    if (this.error) {
      const box = root.createDiv("tb-error");
      box.createEl("h3", { text: "This board couldn't be read" });
      box.createEl("p", { text: this.error });
      box.createEl("p", {
        text: "Nothing has been changed. Open it as markdown to fix the file by hand.",
      });
      const btn = box.createEl("button", { text: "Open as markdown", cls: "mod-cta" });
      btn.onclick = () => this.plugin.openAsMarkdown(this.leaf);
      return;
    }
    if (!this.board) return;

    const boardEl = root.createDiv("tb-board");
    this.board.lanes.forEach((lane, i) => this.renderLane(boardEl, lane, i));
    if (this.showArchive) this.renderArchive(boardEl, this.board.archive ?? []);

    this.restoreScroll(scroll);
  }

  private saveScroll() {
    const board = this.contentEl.querySelector<HTMLElement>(".tb-board");
    const lanes = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".tb-lane-items"));
    return { left: board?.scrollLeft ?? 0, tops: lanes.map((l) => l.scrollTop) };
  }

  private restoreScroll(s: { left: number; tops: number[] }) {
    const board = this.contentEl.querySelector<HTMLElement>(".tb-board");
    if (board) board.scrollLeft = s.left;
    this.contentEl.querySelectorAll<HTMLElement>(".tb-lane-items").forEach((l, i) => {
      l.scrollTop = s.tops[i] ?? 0;
    });
  }

  private renderLane(boardEl: HTMLElement, lane: Lane, laneIndex: number) {
    const laneEl = boardEl.createDiv("tb-lane");

    const header = laneEl.createDiv("tb-lane-header");
    header.createDiv({ cls: "tb-lane-title", text: lane.title });
    const menuBtn = header.createEl("button", { cls: "tb-icon-button clickable-icon", attr: { "aria-label": "Lane menu" } });
    setIcon(menuBtn, "more-vertical");
    menuBtn.onclick = (e) => this.laneMenu(e, laneIndex);

    const items = laneEl.createDiv("tb-lane-items");
    lane.cards.forEach((card, index) => this.renderCard(items, card, { place: laneIndex, index }));
    if (lane.cards.length === 0) items.createDiv("tb-lane-empty");

    this.bindDrop(laneEl, items, laneIndex);

    const footer = laneEl.createDiv("tb-lane-footer");
    if (this.addingTo === laneIndex) {
      this.renderAddForm(footer, laneIndex);
    } else {
      const add = footer.createEl("button", { cls: "tb-add-button" });
      setIcon(add.createSpan("tb-add-icon"), "plus");
      add.createSpan({ text: "Add a card" });
      add.onclick = () => {
        this.addingTo = laneIndex;
        this.render();
      };
    }
  }

  private renderArchive(boardEl: HTMLElement, archive: Card[]) {
    const laneEl = boardEl.createDiv("tb-lane tb-archive");
    const header = laneEl.createDiv("tb-lane-header");
    header.createDiv({ cls: "tb-lane-title", text: `Archive (${archive.length})` });
    const items = laneEl.createDiv("tb-lane-items");
    archive.forEach((card, index) => this.renderCard(items, card, { place: "archive", index }));
    if (archive.length === 0) items.createDiv({ cls: "tb-lane-empty", text: "Nothing archived" });
  }

  private renderCard(parent: HTMLElement, card: Card, ref: CardRef) {
    const el = parent.createDiv("tb-card");
    el.draggable = true;
    const meta = cardMeta(card);

    const titleRow = el.createDiv("tb-card-title-row");
    const title = titleRow.createDiv("tb-card-title markdown-rendered");
    MarkdownRenderer.render(this.app, meta.body, title, this.file?.path ?? "", this.renderer!);

    const more = titleRow.createEl("button", { cls: "tb-icon-button tb-card-more clickable-icon", attr: { "aria-label": "Card menu" } });
    setIcon(more, "more-horizontal");
    more.onclick = (e) => {
      e.stopPropagation();
      this.cardMenu(e, card, ref);
    };

    if (meta.tags.length) {
      const tagsEl = el.createDiv("tb-card-tags");
      for (const tag of this.sortTags(meta.tags)) {
        const t = tagsEl.createEl("a", { cls: "tag tb-tag", text: tag });
        const color = this.tagColor(tag);
        if (color?.color) t.style.setProperty("--tb-tag-color", color.color);
        if (color?.backgroundColor) t.style.setProperty("--tb-tag-bg", color.backgroundColor);
        t.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.openTagSearch(tag);
        };
      }
    }

    if (meta.times.length || meta.dates.length) {
      const metaEl = el.createDiv("tb-card-meta");
      for (const d of meta.dates) {
        const m = (moment as any)(d, "YYYY-MM-DD", true);
        const pill = metaEl.createSpan("tb-pill");
        setIcon(pill.createSpan("tb-pill-icon"), "calendar");
        pill.createSpan({ text: m.isValid() ? m.format("ddd, MMM D") : d });
      }
      if (meta.times.length) {
        const pill = metaEl.createSpan("tb-pill");
        setIcon(pill.createSpan("tb-pill-icon"), "clock");
        pill.createSpan({ text: meta.times.join(" – ") });
      }
    }

    // Clicks inside the rendered markdown: links and sub-task checkboxes.
    title.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const box = target.closest<HTMLInputElement>("input.task-list-item-checkbox");
      if (box) {
        e.preventDefault();
        const n = Array.from(title.querySelectorAll("input.task-list-item-checkbox")).indexOf(box);
        this.mutate((board) => toggleSubtask(this.cards(board, ref.place)[ref.index], n));
        return;
      }
      const link = target.closest<HTMLAnchorElement>("a.internal-link");
      if (link) {
        e.preventDefault();
        const href = link.getAttribute("data-href") ?? link.getAttribute("href") ?? "";
        this.app.workspace.openLinkText(href, this.file?.path ?? "", Keymap.isModEvent(e));
      }
    });

    el.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest("a, input, button")) return;
      this.editCard(el, card, ref);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.cardMenu(e, card, ref);
    });

    el.addEventListener("dragstart", (e) => {
      this.drag = ref;
      e.dataTransfer?.setData("text/plain", cardText(card));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      this.contentEl.addClass("is-dragging");
      requestAnimationFrame(() => el.addClass("is-dragged"));
    });
    el.addEventListener("dragend", () => {
      this.drag = null;
      el.removeClass("is-dragged");
      this.contentEl.removeClass("is-dragging");
      this.clearDropIndicator();
    });
  }

  private bindDrop(laneEl: HTMLElement, items: HTMLElement, laneIndex: number) {
    laneEl.addEventListener("dragover", (e) => {
      if (!this.drag) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const { index, before } = this.dropPosition(items, e.clientY);
      laneEl.addClass("is-drop-target");
      const indicator = (this.dropIndicator ??= createDiv("tb-drop-indicator"));
      if (before) items.insertBefore(indicator, before);
      else items.appendChild(indicator);
      indicator.dataset.index = String(index);
    });
    laneEl.addEventListener("dragleave", (e) => {
      if (!laneEl.contains(e.relatedTarget as Node)) {
        laneEl.removeClass("is-drop-target");
        if (this.dropIndicator?.parentElement === items) this.dropIndicator.detach();
      }
    });
    laneEl.addEventListener("drop", (e) => {
      if (!this.drag) return;
      e.preventDefault();
      const from = this.drag;
      const { index } = this.dropPosition(items, e.clientY);
      this.drag = null;
      this.clearDropIndicator();
      if (from.place === laneIndex) {
        // Same lane: index counts cards other than the dragged one.
        if (index === from.index) return;
      }
      this.moveCard(from, laneIndex, index);
    });
  }

  /** Index among the lane's cards (dragged card excluded) and the element to insert before. */
  private dropPosition(items: HTMLElement, y: number) {
    const cards = Array.from(items.querySelectorAll<HTMLElement>(":scope > .tb-card:not(.is-dragged)"));
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return { index: i, before: cards[i] as HTMLElement | null };
    }
    return { index: cards.length, before: null };
  }

  private clearDropIndicator() {
    this.dropIndicator?.detach();
    this.contentEl.querySelectorAll(".is-drop-target").forEach((l) => l.removeClass("is-drop-target"));
  }

  // ---- Editing and adding ----

  private editCard(el: HTMLElement, card: Card, ref: CardRef) {
    el.empty();
    el.draggable = false;
    el.addClass("is-editing");
    const input = el.createEl("textarea", { cls: "tb-input" });
    input.value = cardText(card);
    autoGrow(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const text = input.value.trim();
      if (save && text && text !== cardText(card)) {
        this.mutate((board) => setCardText(this.cards(board, ref.place)[ref.index], text));
      } else {
        this.render();
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }

  private renderAddForm(footer: HTMLElement, laneIndex: number) {
    const input = footer.createEl("textarea", { cls: "tb-input", attr: { placeholder: "Card title… (Enter to add, Esc to stop)" } });
    autoGrow(input);
    setTimeout(() => input.focus(), 0);

    const close = () => {
      if (this.addingTo === laneIndex) this.addingTo = null;
      this.render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return close();
        // Keep the form open for the next card.
        this.mutate((board) => {
          const lane = board.lanes[laneIndex];
          lane.cards.push(newCard(text, lane.complete));
        });
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });
    input.addEventListener("blur", () => {
      if (!input.value.trim()) setTimeout(close, 100);
    });
  }

  // ---- Menus ----

  private cardMenu(e: MouseEvent, card: Card, ref: CardRef) {
    const board = this.board!;
    const menu = new Menu();

    if (ref.place === "archive") {
      board.lanes.forEach((lane, i) =>
        menu.addItem((item) =>
          item
            .setTitle(`Restore to ${lane.title}`)
            .setIcon("undo-2")
            .onClick(() => this.moveCard(ref, i, 0)),
        ),
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle("Delete card")
          .setIcon("trash-2")
          .setWarning(true)
          .onClick(() => this.deleteCard(ref)),
      );
      menu.showAtMouseEvent(e);
      return;
    }

    const lanes = board.lanes;
    const laneIndex = ref.place;
    menu.addItem((item) =>
      item
        .setTitle("Edit card")
        .setIcon("pencil")
        .onClick(() => {
          const el = this.cardEl(ref);
          if (el) this.editCard(el, card, ref);
        }),
    );
    if (card.check !== null) {
      const done = card.check === "x";
      menu.addItem((item) =>
        item
          .setTitle(done ? "Mark as not done" : "Mark as done")
          .setIcon(done ? "square" : "check-square")
          .onClick(() =>
            this.mutate((b) => {
              b.lanes[laneIndex].cards[ref.index].check = done ? " " : "x";
            }),
          ),
      );
    }

    menu.addSeparator();
    if (ref.index > 0)
      menu.addItem((item) =>
        item.setTitle("Move to top").setIcon("arrow-up-to-line").onClick(() => this.moveCard(ref, laneIndex, 0)),
      );
    if (ref.index < lanes[laneIndex].cards.length - 1)
      menu.addItem((item) =>
        item
          .setTitle("Move to bottom")
          .setIcon("arrow-down-to-line")
          .onClick(() => this.moveCard(ref, laneIndex, lanes[laneIndex].cards.length)),
      );
    lanes.forEach((lane, i) => {
      if (i === laneIndex) return;
      menu.addItem((item) =>
        item
          .setTitle(`Move to ${lane.title}`)
          .setIcon("arrow-right")
          .onClick(() => this.moveCard(ref, i, lane.complete ? 0 : lane.cards.length)),
      );
    });

    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Archive card").setIcon("archive").onClick(() => this.archiveCard(ref)));
    menu.addItem((item) =>
      item
        .setTitle("Delete card")
        .setIcon("trash-2")
        .setWarning(true)
        .onClick(() => this.deleteCard(ref)),
    );
    menu.showAtMouseEvent(e);
  }

  private laneMenu(e: MouseEvent, laneIndex: number) {
    const lane = this.board!.lanes[laneIndex];
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Add a card")
        .setIcon("plus")
        .onClick(() => {
          this.addingTo = laneIndex;
          this.render();
        }),
    );
    if (lane.cards.length)
      menu.addItem((item) =>
        item
          .setTitle(`Archive all ${lane.cards.length} cards`)
          .setIcon("archive")
          .onClick(() => this.archiveLane(laneIndex)),
      );
    menu.showAtMouseEvent(e);
  }

  private cardEl(ref: CardRef): HTMLElement | null {
    const lanes = this.contentEl.querySelectorAll(".tb-lane:not(.tb-archive)");
    const lane = ref.place === "archive" ? this.contentEl.querySelector(".tb-archive") : lanes[ref.place];
    return (lane?.querySelectorAll<HTMLElement>(".tb-card")[ref.index] as HTMLElement) ?? null;
  }

  // ---- Tags ----

  private tagColor(tag: string): TagColor | undefined {
    return this.board?.settings["tag-colors"]?.find((c) => c.tagKey === tag);
  }

  private sortTags(tags: string[]): string[] {
    const order = (this.board?.settings["tag-sort"] ?? []).map((t) => t.tag);
    const rank = (t: string) => (order.includes(t) ? order.indexOf(t) : order.length);
    return [...tags].sort((a, b) => rank(a) - rank(b));
  }

  private openTagSearch(tag: string) {
    const search = (this.app as any).internalPlugins?.getPluginById?.("global-search")?.instance;
    search?.openGlobalSearch?.(`tag:${tag}`);
  }
}

function isTyping(evt: KeyboardEvent) {
  const t = evt.target as HTMLElement | null;
  return !!t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable);
}

function autoGrow(input: HTMLTextAreaElement) {
  const fit = () => {
    input.style.height = "auto";
    input.style.height = input.scrollHeight + "px";
  };
  input.addEventListener("input", fit);
  requestAnimationFrame(fit);
}
