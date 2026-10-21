// Just enough of Obsidian's API (and its DOM helpers) to exercise the view headlessly.
// The card editor is Obsidian's own and can't run here; the real app covers that.
import { Window } from "happy-dom";

const win = new Window();
const g = globalThis as any;
for (const k of ["document", "HTMLElement", "Element", "Node", "HTMLInputElement", "MouseEvent", "KeyboardEvent", "Event", "getComputedStyle", "DOMRect"])
  g[k] = (win as any)[k];
g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);

type Info = string | { cls?: string; text?: string; type?: string; attr?: Record<string, string> };
function build(tag: string, info?: Info, ns?: string): HTMLElement {
  const el = (ns ? document.createElementNS(ns, tag) : document.createElement(tag)) as HTMLElement;
  if (typeof info === "string") el.setAttribute("class", info);
  else if (info) {
    if (info.cls) el.setAttribute("class", info.cls);
    if (info.text) el.textContent = info.text;
    if (info.type) el.setAttribute("type", info.type);
    for (const [k, v] of Object.entries(info.attr ?? {})) el.setAttribute(k, v);
  }
  return el;
}
const E = (win as any).Element.prototype;
E.createEl = function (tag: string, info?: Info) { return this.appendChild(build(tag, info)); };
E.createDiv = function (info?: Info) { return this.createEl("div", info); };
E.createSpan = function (info?: Info) { return this.createEl("span", info); };
E.createSvg = function (tag: string, info?: Info, cb?: (el: Element) => void) {
  const el = this.appendChild(build(tag, info, "http://www.w3.org/2000/svg"));
  cb?.(el);
  return el;
};
E.empty = function () { this.innerHTML = ""; };
E.addClass = function (...c: string[]) { this.classList.add(...c); };
E.removeClass = function (...c: string[]) { this.classList.remove(...c); };
E.toggleClass = function (c: string, on: boolean) { this.classList.toggle(c, on); };
E.hasClass = function (c: string) { return this.classList.contains(c); };
E.detach = function () { this.remove(); };
E.hide = function () { this.style.display = "none"; };
E.show = function () { this.style.display = ""; };
E.appendText = function (t: string) { this.appendChild(document.createTextNode(t)); };
Object.defineProperty(E, "doc", { get() { return this.ownerDocument; } });
g.createDiv = (info?: Info) => build("div", info);

export class Component {
  children: Component[] = [];
  load() {}
  unload() {}
  addChild<T extends Component>(c: T): T { this.children.push(c); return c; }
  removeChild<T extends Component>(c: T): T { this.children = this.children.filter((x) => x !== c); return c; }
  registerDomEvent(el: EventTarget, type: string, fn: EventListener, opts?: unknown) { el.addEventListener(type, fn, opts as any); }
  register() {}
}
export class Scope { constructor(_p?: unknown) {} register() {} }
export class Notice { constructor(msg: string) { (g.notices ??= []).push(msg); } }
export const Keymap = { isModEvent: () => false };
export const Platform = { isMobile: false, isPhone: false };
export const setIcon = () => {};
const fakeMoment: any = () => ({ isValid: () => true, format: () => "", startOf: () => fakeMoment(), isSame: () => false, isAfter: () => false });
export const moment = fakeMoment;
export const MarkdownRenderer = {
  render: async (_a: unknown, md: string, el: HTMLElement) => {
    // Sub-tasks become checkboxes (so toggling can be tested); inline HTML is kept, as Obsidian does.
    for (const line of md.split("\n")) {
      const m = line.match(/^- \[(.)\] (.*)$/);
      if (m) {
        el.createEl("input", { cls: "task-list-item-checkbox", type: "checkbox" });
        el.createSpan({ text: m[2] });
      } else el.createEl("p").innerHTML = line;
    }
  },
};
export class Menu {
  items: { title: string; click: () => void; submenu?: Menu }[] = [];
  addItem(cb: (i: any) => void) {
    const it: any = { title: "", click: () => {} };
    const api: any = {
      setTitle: (t: string) => ((it.title = t), api), setIcon: () => api, setSection: () => api,
      setWarning: () => api, setChecked: () => api, onClick: (f: () => void) => ((it.click = f), api),
      setSubmenu: () => (it.submenu = new Menu()),
    };
    cb(api);
    this.items.push(it);
    return this;
  }
  addSeparator() { return this; }
  showAtMouseEvent() { g.lastMenu = this; }
  showAtPosition() { g.lastMenu = this; }
}
export class TextFileView extends Component {
  containerEl = build("div");
  contentEl = this.containerEl.appendChild(build("div"));
  data = "";
  file = { path: "TODO.md", basename: "TODO" };
  app: any = { scope: null, workspace: { trigger() {}, openLinkText() {} }, vault: { getConfig: () => false } };
  scope: unknown;
  saves = 0;
  leaf: unknown;
  constructor(leaf: unknown) { super(); this.leaf = leaf; }
  addAction() { return build("div"); }
  requestSave() { this.saves++; }
  onPaneMenu() {}
}
export class EditorSuggest<T> { app: unknown; context: any; limit = 0; constructor(app: unknown) { this.app = app; } __t?: T; }
export class Plugin {}
export class TFile {}
export class WorkspaceLeaf {}
export const normalizePath = (p: string) => p;
export class Modal { app: unknown; constructor(app: unknown) { this.app = app; } open() {} close() {} }
export class Setting { constructor(_el: unknown) {} }
export const requestUrl = async () => {
  throw new Error("no network in tests");
};
export const debounce = (fn: (...a: unknown[]) => unknown) => fn;
export class PluginSettingTab {}
