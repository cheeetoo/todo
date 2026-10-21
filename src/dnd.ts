// Pointer-based drag and drop that works with a mouse and on a phone, modelled
// on obsidian-kanban's: a mouse drag starts after 5px of movement, a touch drag
// after a 500ms long press (moving sooner scrolls instead). The dragged element
// follows the pointer in a .kanban-plugin__drag-container while a placeholder
// opens a gap where it will land.

export type DragKind = "card" | "lane";

export interface DropResult {
  kind: DragKind;
  /** The dragged element (an item wrapper or a lane wrapper). */
  el: HTMLElement;
  /** Destination lane for cards; destination lane position for lanes. */
  lane: number;
  /** Card position in the destination lane, counting only the other cards. */
  index: number;
}

export interface DragHost {
  root(): HTMLElement | null;
  onDragStart(): void;
  /** Return false to cancel (the element slides back). */
  onDrop(result: DropResult): void;
  onDragEnd(): void;
}

const LONG_PRESS_MS = 500;
const SLOP_PX = 5;
const EDGE_PX = 35;
const MAX_SCROLL = 10;
const EASE = "cubic-bezier(0.2, 0, 0, 1)";
const DROP_EASE = "cubic-bezier(.2,1,.1,1)";

const ITEM = ".kanban-plugin__item-wrapper";
const LANE = ".kanban-plugin__lane-wrapper";

interface Session {
  kind: DragKind;
  el: HTMLElement;
  win: Window;
  overlay: HTMLElement;
  placeholder: HTMLElement;
  grab: { x: number; y: number };
  pointer: { x: number; y: number };
  lane: number;
  index: number;
  raf: number;
}

export class DragController {
  session: Session | null = null;
  private host: DragHost;

  constructor(host: DragHost) {
    this.host = host;
  }

  get active() {
    return !!this.session;
  }

  /** Make `handle` start dragging `el`. */
  bind(handle: HTMLElement, el: HTMLElement, kind: DragKind) {
    handle.addEventListener("pointerdown", (e) => this.onPointerDown(e, el, kind));
    // Keep Obsidian's mobile swipe gestures (sidebars) out of it.
    handle.addEventListener("touchstart", (e) => e.stopPropagation());
  }

  private onPointerDown(e: PointerEvent, el: HTMLElement, kind: DragKind) {
    if (e.defaultPrevented || this.session || !el.isConnected) return;
    if ((e.target as HTMLElement).closest("[data-ignore-drag], .cm-editor, input, textarea, button")) return;
    if (e.button !== 0 && e.buttons !== 1) return;

    const win = (e.view ?? window) as Window;
    const isTouch = e.pointerType === "touch" || e.pointerType === "pen";
    // A mouse press on a card shouldn't start selecting text.
    if (!isTouch) e.preventDefault();
    const pointerId = e.pointerId;
    const origin = { x: e.clientX, y: e.clientY };
    let started = false;
    let timer = 0;

    const cancelEvent = (ev: Event) => {
      ev.preventDefault();
      ev.stopPropagation();
    };

    const start = (x: number, y: number) => {
      if (!el.isConnected) return cleanup();
      started = true;
      this.start(el, kind, win, origin, { x, y });
    };

    if (isTouch) {
      win.addEventListener("contextmenu", cancelEvent, true);
      timer = win.setTimeout(() => {
        start(origin.x, origin.y);
        win.addEventListener("touchmove", cancelEvent, { passive: false });
        (navigator as any).vibrate?.(10);
      }, LONG_PRESS_MS);
    }

    const cleanup = () => {
      win.clearTimeout(timer);
      win.removeEventListener("pointermove", onMove);
      win.removeEventListener("pointerup", onUp);
      win.removeEventListener("pointercancel", onCancel);
      win.removeEventListener("contextmenu", cancelEvent, true);
      win.removeEventListener("touchmove", cancelEvent);
      win.removeEventListener("keydown", onKey, true);
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const far = Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) > SLOP_PX;
      if (!started) {
        if (!far) return;
        if (isTouch) return cleanup(); // moved before the long press: it's a scroll
        start(ev.clientX, ev.clientY);
      }
      this.move(ev.clientX, ev.clientY);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      cleanup();
      if (started) this.finish(true);
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      cleanup();
      if (started) this.finish(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !started) return;
      cancelEvent(ev);
      cleanup();
      this.finish(false);
    };

    win.addEventListener("pointermove", onMove);
    win.addEventListener("pointerup", onUp);
    win.addEventListener("pointercancel", onCancel);
    win.addEventListener("keydown", onKey, true);
  }

  private start(el: HTMLElement, kind: DragKind, win: Window, origin: { x: number; y: number }, at: { x: number; y: number }) {
    const root = this.host.root();
    if (!root) return;
    this.host.onDragStart();

    const rect = el.getBoundingClientRect();
    const doc = win.document;

    const overlay = doc.body.createDiv("kanban-plugin__drag-container");
    const clone = el.cloneNode(true) as HTMLElement;
    clone.style.width = `${rect.width}px`;
    overlay.appendChild(clone);
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    // Lanes inherit --lane-width etc. from the board root; carry them along.
    overlay.style.cssText += root.style.cssText;
    overlay.addClass("tb-drag-overlay");

    const placeholder = doc.createElement("div");
    placeholder.className = "tb-placeholder";
    placeholder.dataset.kind = kind;
    if (kind === "card") placeholder.style.height = `${rect.height}px`;
    else placeholder.style.width = `${rect.width}px`;

    el.parentElement!.insertBefore(placeholder, el);
    el.addClass("tb-drag-source");
    root.addClass("something-is-dragging");
    doc.body.addClass("tb-is-dragging");

    const s: Session = {
      kind,
      el,
      win,
      overlay,
      placeholder,
      grab: { x: origin.x - rect.left, y: origin.y - rect.top },
      pointer: at,
      lane: -1,
      index: -1,
      raf: 0,
    };
    this.session = s;
    this.position();
    this.retarget();

    const tick = () => {
      if (this.session !== s) return;
      if (this.autoscroll()) this.retarget();
      s.raf = win.requestAnimationFrame(tick);
    };
    s.raf = win.requestAnimationFrame(tick);
  }

  private move(x: number, y: number) {
    const s = this.session;
    if (!s) return;
    s.pointer = { x, y };
    this.position();
    this.retarget();
  }

  private position() {
    const s = this.session!;
    s.overlay.style.transform = `translate3d(${s.pointer.x - s.grab.x}px, ${s.pointer.y - s.grab.y}px, 0)`;
  }

  private lanes(): HTMLElement[] {
    const root = this.host.root();
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(`.kanban-plugin__board ${LANE}`));
  }

  /** Work out where the pointer is aiming and move the placeholder there. */
  private retarget() {
    const s = this.session!;
    const { x, y } = s.pointer;
    const lanes = this.lanes();

    if (s.kind === "lane") {
      const others = lanes.filter((l) => l !== s.el);
      let index = others.findIndex((l) => {
        const r = layoutRect(l);
        return x < r.left + r.width / 2;
      });
      if (index === -1) index = others.length;
      if (index === s.index) return;
      s.index = index;
      s.lane = index;
      const container = s.el.parentElement!;
      const before = others[index] ?? container.querySelector(":scope > .kanban-plugin__lane-placeholder");
      this.flip(others, () => container.insertBefore(s.placeholder, before ?? null));
      return;
    }

    // Cards: the lane under the pointer, or the nearest one horizontally.
    let laneIndex = -1;
    let best = Infinity;
    lanes.forEach((l, i) => {
      const r = l.getBoundingClientRect();
      const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (d < best) {
        best = d;
        laneIndex = i;
      }
    });
    if (laneIndex === -1) return;
    const laneEl = lanes[laneIndex];
    const collapsed = laneEl.hasClass("collapse-horizontal");
    const items = laneEl.querySelector<HTMLElement>(".kanban-plugin__lane-items");

    lanes.forEach((l, i) => l.toggleClass("is-dropping", i === laneIndex && collapsed));

    if (collapsed || !items) {
      // A collapsed lane: drop at the top.
      if (s.lane === laneIndex && s.index === 0) return;
      s.lane = laneIndex;
      s.index = 0;
      s.placeholder.detach();
      return;
    }

    const cards = Array.from(items.querySelectorAll<HTMLElement>(`:scope > ${ITEM}`)).filter(
      (c) => c !== s.el && c.offsetParent !== null,
    );
    let index = cards.findIndex((c) => {
      const r = layoutRect(c);
      return y < r.top + r.height / 2;
    });
    if (index === -1) index = cards.length;
    // Hidden (search-filtered) cards still count towards the real index.
    const all = Array.from(items.querySelectorAll<HTMLElement>(`:scope > ${ITEM}`)).filter((c) => c !== s.el);
    const realIndex = index < cards.length ? all.indexOf(cards[index]) : all.length;

    if (s.lane === laneIndex && s.index === realIndex) return;
    const oldItems = s.placeholder.parentElement;
    s.lane = laneIndex;
    s.index = realIndex;

    const affected = new Set<HTMLElement>(cards);
    if (oldItems && oldItems !== items)
      oldItems.querySelectorAll<HTMLElement>(`:scope > ${ITEM}`).forEach((c) => affected.add(c));
    const before = cards[index] ?? items.querySelector(":scope > .kanban-plugin__placeholder");
    this.flip([...affected], () => items.insertBefore(s.placeholder, before ?? null));
  }

  /** Animate elements from where they were to where `change` puts them. */
  private flip(els: HTMLElement[], change: () => void) {
    const before = new Map(els.map((el) => [el, el.getBoundingClientRect()]));
    change();
    for (const el of els) {
      el.style.transition = "none";
      el.style.transform = "";
    }
    for (const el of els) {
      const a = before.get(el)!;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (!dx && !dy) continue;
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      void el.offsetHeight;
      el.style.transition = `transform 200ms ${EASE}`;
      el.style.transform = "";
    }
  }

  /** Scroll the board / a lane when the pointer is near an edge. True if anything moved. */
  private autoscroll(): boolean {
    const s = this.session!;
    const root = this.host.root();
    if (!root) return false;
    const { x, y } = s.pointer;
    let moved = false;
    const speed = (dist: number) => Math.ceil(MAX_SCROLL * (1 - Math.max(0, dist) / EDGE_PX));

    const board = root.querySelector<HTMLElement>(".kanban-plugin__board");
    if (board) {
      const r = board.getBoundingClientRect();
      const prev = board.scrollLeft;
      if (x < r.left + EDGE_PX) board.scrollLeft -= speed(x - r.left);
      else if (x > r.right - EDGE_PX) board.scrollLeft += speed(r.right - x);
      moved ||= board.scrollLeft !== prev;
    }
    if (s.kind === "card") {
      for (const items of Array.from(root.querySelectorAll<HTMLElement>(".kanban-plugin__lane-items"))) {
        const r = items.getBoundingClientRect();
        if (x < r.left || x > r.right) continue;
        const prev = items.scrollTop;
        if (y < r.top + EDGE_PX && y > r.top - EDGE_PX) items.scrollTop -= speed(y - r.top);
        else if (y > r.bottom - EDGE_PX && y < r.bottom + EDGE_PX) items.scrollTop += speed(r.bottom - y);
        moved ||= items.scrollTop !== prev;
      }
    }
    return moved;
  }

  private finish(drop: boolean) {
    const s = this.session;
    if (!s) return;
    s.win.cancelAnimationFrame(s.raf);

    const target = drop && s.lane >= 0 ? { lane: s.lane, index: s.index } : null;
    // Fly to the gap (or back home), then hand over.
    const home = (target && s.placeholder.isConnected ? s.placeholder : null) ?? this.restoreHome(s);
    const r = home.getBoundingClientRect();
    s.overlay.style.transition = `transform 220ms ${DROP_EASE}`;
    s.overlay.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;

    const done = () => {
      if (this.session !== s) return;
      this.session = null;
      s.overlay.remove();
      s.placeholder.remove();
      s.el.removeClass("tb-drag-source");
      this.host.root()?.removeClass("something-is-dragging");
      this.host.root()?.querySelectorAll(".is-dropping").forEach((l) => l.removeClass("is-dropping"));
      s.win.document.body.removeClass("tb-is-dragging");
      for (const el of Array.from(this.host.root()?.querySelectorAll<HTMLElement>(`${ITEM}, ${LANE}`) ?? [])) {
        el.style.transition = "";
        el.style.transform = "";
      }
      if (target) this.host.onDrop({ kind: s.kind, el: s.el, lane: target.lane, index: target.index });
      this.host.onDragEnd();
    };
    s.win.setTimeout(done, 230);
  }

  /** Put the placeholder back where the element started, for a cancelled drag. */
  private restoreHome(s: Session): HTMLElement {
    s.el.parentElement?.insertBefore(s.placeholder, s.el);
    return s.placeholder;
  }
}

/** Where an element sits ignoring any transform it's animating through. */
function layoutRect(el: HTMLElement): DOMRect {
  const r = el.getBoundingClientRect();
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return r;
  const m = new DOMMatrixReadOnly(t);
  return new DOMRect(r.left - m.m41, r.top - m.m42, r.width, r.height);
}
