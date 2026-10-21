// Embeds Obsidian's own markdown editor (the one notes use: vim, live preview,
// autocomplete, the mobile toolbar) in a card. Obsidian doesn't export the
// class, so it's pulled off a throwaway embed, the same way obsidian-kanban does.

import { insertBlankLine } from "@codemirror/commands";
import { EditorSelection, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt, type ViewUpdate } from "@codemirror/view";
import { Platform, type App } from "obsidian";
import type { BoardView } from "./view";

let MarkdownEditorClass: any = null;

function getEditorClass(app: App): any {
  if (MarkdownEditorClass) return MarkdownEditorClass;
  const md = (app as any).embedRegistry.embedByExtension.md({ app, containerEl: createDiv(), state: {} }, null, "");
  md.load();
  md.editable = true;
  md.showEditor();
  MarkdownEditorClass = Object.getPrototypeOf(Object.getPrototypeOf(md.editMode)).constructor;
  md.unload();
  return MarkdownEditorClass;
}

/** Editors living in a board, so our suggesters only fire there. */
export const boardEditors = new WeakMap<EditorView, BoardView>();

export interface EditorOptions {
  value: string;
  cls: string;
  placeholder?: string;
  /** Put the cursor under this screen point (a double-click); otherwise at the end. */
  cursorAt?: { x: number; y: number };
  /** Return true when Enter was handled (submitted); false inserts a newline. */
  onEnter(cm: EditorView, mod: boolean, shift: boolean): boolean;
  /** Escape that vim didn't need (vim is in normal mode, or vim is off). */
  onEscape(cm: EditorView): void;
  onSubmit(cm: EditorView): void;
  onChange?(cm: EditorView): void;
}

export interface MountedEditor {
  cm: EditorView;
  el: HTMLElement;
  value(): string;
  setValue(text: string): void;
  focus(): void;
  destroy(): void;
}

/** obsidian-kanban's rule: on mobile Enter is a newline; on desktop it depends on new-line-trigger. */
export function allowNewLine(trigger: "enter" | "shift-enter", mod: boolean, shift: boolean): boolean {
  if (Platform.isMobile) return !(mod || shift);
  return trigger === "enter" ? !(mod || shift) : mod || shift;
}

function vimOf(cm: EditorView): any {
  const plugin = (cm as any)?.plugins?.find(
    (p: any) => p?.value && "useNextTextInput" in p.value && "waitForCopy" in p.value,
  );
  return plugin?.value?.cm;
}

/** True when vim should get this Escape: leaving insert/visual mode or abandoning a pending command. */
function vimWantsEscape(cm: EditorView): boolean {
  const vim = vimOf(cm)?.state?.vim;
  if (!vim) return false;
  const input = vim.inputState;
  return !!(vim.insertMode || vim.visualMode || input?.operator || input?.motion || input?.keyBuffer?.length);
}

function enterInsertMode(cm: EditorView) {
  const adapter = vimOf(cm);
  if (adapter) (window as any).CodeMirrorAdapter?.Vim?.enterInsertMode(adapter);
}

/** Hide line numbers and folding inside cards, whatever the vault uses for notes. */
function appProxy(app: App): App {
  return new Proxy(app, {
    get(target, prop, receiver) {
      if (prop !== "vault") return Reflect.get(target, prop, receiver);
      return new Proxy(app.vault, {
        get(vault, p, r) {
          if (p !== "config") return Reflect.get(vault, p, r);
          return new Proxy((app.vault as any).config, {
            get(config, key, rr) {
              if (key === "showLineNumber" || key === "foldHeading" || key === "foldIndent") return false;
              return Reflect.get(config, key, rr);
            },
          });
        },
      });
    },
  });
}

export function mountEditor(view: BoardView, parent: HTMLElement, opts: EditorOptions): MountedEditor {
  const app = view.app;
  const Base = getEditorClass(app);
  const el = parent.createDiv({ cls: `cm-table-widget ${opts.cls}` });

  let editor: any;
  const controller: Record<string, any> = {
    app,
    showSearch() {},
    toggleMode() {},
    onMarkdownScroll() {},
    getMode: () => "source",
    scroll: 0,
    editMode: null,
    get editor() {
      return editor?.editor;
    },
    get file() {
      return view.file;
    },
    get path() {
      return view.file?.path;
    },
  };

  class CardEditor extends Base {
    updateBottomPadding() {}

    onUpdate(update: ViewUpdate, changed: boolean) {
      super.onUpdate(update, changed);
      if (update.docChanged) opts.onChange?.(update.view);
    }

    buildLocalExtensions(): Extension[] {
      const extensions: Extension[] = super.buildLocalExtensions();

      extensions.push(
        Prec.highest(
          EditorView.domEventHandlers({
            focus: (evt) => {
              view.activeEditor = controller;
              if (Platform.isMobile) view.contentEl.addClass("is-mobile-editing");
              (evt.view ?? window).setTimeout(() => {
                (app.workspace as any).activeEditor = controller;
                if (Platform.isMobile) (app as any).mobileToolbar?.update();
              });
              return false;
            },
            blur: () => {
              if (Platform.isMobile) {
                view.contentEl.removeClass("is-mobile-editing");
                (app as any).mobileToolbar?.update();
              }
              return false;
            },
          }),
        ),
      );

      if (opts.placeholder) extensions.push(placeholderExt(opts.placeholder));

      const enter = (mod: boolean, shift: boolean) => (cm: EditorView) => {
        if (opts.onEnter(cm, mod, shift)) return true;
        if ((app.vault as any).getConfig("smartIndentList")) this.editor.newlineAndIndentContinueMarkdownList();
        else insertBlankLine(cm);
        return true;
      };

      extensions.push(
        Prec.highest(
          keymap.of([
            { key: "Enter", run: enter(false, false), shift: enter(false, true), preventDefault: true },
            { key: "Mod-Enter", run: enter(true, false), shift: enter(true, true), preventDefault: true },
            {
              key: "Escape",
              run: (cm) => {
                // In insert mode, Escape belongs to vim: drop to normal mode and stay in the card.
                if (vimWantsEscape(cm)) return false;
                opts.onEscape(cm);
                return true;
              },
            },
          ]),
        ),
      );

      return extensions;
    }
  }

  editor = view.addChild(new (CardEditor as any)(appProxy(app), el, controller));
  controller.editMode = editor;
  const cm: EditorView = editor.cm;
  boardEditors.set(cm, view);
  editor.set(opts.value ?? "");

  const pos = opts.cursorAt ? cm.posAtCoords(opts.cursorAt, false) : cm.state.doc.length;
  cm.dispatch({ userEvent: "select.pointer", selection: EditorSelection.single(pos ?? cm.state.doc.length) });
  cm.focus();
  (cm.dom.win ?? window).setTimeout(() => enterInsertMode(cm));

  let submitBtn: HTMLElement | null = null;
  if (Platform.isMobile) {
    submitBtn = parent.createEl("button", { cls: "kanban-plugin__item-submit-button mod-cta", text: "Submit" });
    submitBtn.onclick = () => opts.onSubmit(cm);
  }

  const onKeyboard = () => el.scrollIntoView({ block: "end" });
  if (Platform.isMobile) cm.dom.win.addEventListener("keyboardDidShow", onKeyboard);

  return {
    cm,
    el,
    value: () => cm.state.doc.toString(),
    setValue(text: string) {
      cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: text } });
    },
    focus: () => cm.focus(),
    destroy() {
      if (Platform.isMobile) cm.dom.win.removeEventListener("keyboardDidShow", onKeyboard);
      if (view.activeEditor === controller) view.activeEditor = null;
      if ((app.workspace as any).activeEditor === controller) {
        (app.workspace as any).activeEditor = null;
        if (Platform.isMobile) (app as any).mobileToolbar?.update();
      }
      view.contentEl.removeClass("is-mobile-editing");
      boardEditors.delete(cm);
      view.removeChild(editor);
      submitBtn?.remove();
      el.remove();
    },
  };
}
