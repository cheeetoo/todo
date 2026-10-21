// Just enough of Obsidian's API (and its DOM helpers) to exercise the view headlessly.
import { Window } from "happy-dom";

const win = new Window();
const g = globalThis as any;
for (const k of ["document", "HTMLElement", "Node", "HTMLInputElement", "HTMLTextAreaElement", "MouseEvent", "KeyboardEvent", "Event"])
  g[k] = (win as any)[k];
g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);

type Info = string | { cls?: string; text?: string; attr?: Record<string, string> };
function build(tag: string, info?: Info): HTMLElement {
  const el = document.createElement(tag) as HTMLElement;
  if (typeof info === "string") el.className = info;
  else if (info) {
    if (info.cls) el.className = info.cls;
    if (info.text) el.textContent = info.text;
    for (const [k, v] of Object.entries(info.attr ?? {})) el.setAttribute(k, v);
  }
  return el;
}
const P = (win as any).HTMLElement.prototype;
P.createEl = function (tag: string, info?: Info) { return this.appendChild(build(tag, info)); };
P.createDiv = function (info?: Info) { return this.createEl("div", info); };
P.createSpan = function (info?: Info) { return this.createEl("span", info); };
P.empty = function () { this.innerHTML = ""; };
P.addClass = function (...c: string[]) { this.classList.add(...c); };
P.removeClass = function (...c: string[]) { this.classList.remove(...c); };
P.toggleClass = function (c: string, on: boolean) { this.classList.toggle(c, on); };
P.detach = function () { this.remove(); };
g.createDiv = (info?: Info) => build("div", info);

export class Component { load() {} unload() {} }
export class Scope { constructor(_p?: unknown) {} register() {} }
export class Notice { constructor(msg: string) { (g.notices ??= []).push(msg); } }
export const Keymap = { isModEvent: () => false };
export const setIcon = () => {};
export const moment = (s: string) => ({ isValid: () => true, format: () => s });
export const MarkdownRenderer = {
  render: async (_a: unknown, md: string, el: HTMLElement) => {
    // Render "- [ ] x" lines as checkboxes so sub-task toggling can be tested.
    for (const line of md.split("\n")) {
      const m = line.match(/^- \[(.)\] (.*)$/);
      if (m) {
        const box = el.createEl("input", { cls: "task-list-item-checkbox" }) as HTMLInputElement;
        box.type = "checkbox";
        el.createSpan({ text: m[2] });
      } else el.createEl("p", { text: line });
    }
  },
};
export class Menu {
  items: { title: string; click: () => void }[] = [];
  addItem(cb: (i: any) => void) {
    const it: any = { title: "", click: () => {} };
    const api: any = {
      setTitle: (t: string) => ((it.title = t), api), setIcon: () => api, setSection: () => api,
      setWarning: () => api, onClick: (f: () => void) => ((it.click = f), api),
    };
    cb(api);
    this.items.push(it);
    return this;
  }
  addSeparator() { return this; }
  showAtMouseEvent() { g.lastMenu = this; }
}
export class TextFileView {
  contentEl = build("div");
  data = "";
  file = { path: "TODO.md", basename: "TODO" };
  app: any = { scope: null, workspace: {} };
  scope: unknown;
  saves = 0;
  leaf: unknown;
  constructor(leaf: unknown) { this.leaf = leaf; }
  addAction() { return build("div"); }
  requestSave() { this.saves++; }
  onPaneMenu() {}
}
export class Plugin {}
export class TFile {}
export class WorkspaceLeaf {}
