import { autocompletion, completionKeymap, insertCompletionText, pickedCompletion, type CompletionSource } from "@codemirror/autocomplete";
import { forEachDiagnostic, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, keymap, showTooltip, tooltips, ViewPlugin, type DecorationSet, type Tooltip, type ViewUpdate } from "@codemirror/view";
import type { EditorQuery, EditorResult } from "@openorc/protocol";
import type { CodeEditorActions, EditorIntelligence, EditorPoint } from "./types";

const bindings = new WeakMap<EditorView, () => EditorIntelligence | undefined>();
const api = (view: EditorView) => bindings.get(view)?.();
export const point = (view: EditorView): EditorPoint => {
  const position = view.state.selection.main.head;
  const line = view.state.doc.lineAt(position);
  return { line: line.number, column: position - line.from + 1 };
};

async function ask(view: EditorView, query: EditorQuery): Promise<EditorResult | null> {
  const host = api(view);
  if (!host) return null;
  try {
    const result = await host.query(query, view.state.doc.toString());
    if (!bindings.has(view)) return null;
    host.error(result.kind === "unavailable" ? result.reason : null);
    return result;
  } catch (error) {
    if (bindings.has(view)) host.error(error instanceof Error ? error.message : "Code intelligence could not load.");
    return null;
  }
}

function information(display: string, documentation: string, parameter?: string): HTMLDivElement {
  const dom = document.createElement("div");
  dom.className = "cm-editor-information";
  const code = dom.appendChild(document.createElement("pre"));
  code.textContent = display;
  if (parameter) dom.appendChild(document.createElement("code")).textContent = parameter;
  if (documentation) dom.appendChild(document.createElement("p")).textContent = documentation;
  return dom;
}

const setSignature = StateEffect.define<Tooltip | null>();
const signature = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, transaction) {
    if (transaction.docChanged || transaction.selection) value = null;
    for (const effect of transaction.effects) if (effect.is(setSignature)) value = effect.value;
    return value;
  },
  provide: (field) => showTooltip.from(field),
});

async function navigate(view: EditorView, kind: "definition" | "references", position = view.state.selection.main.head): Promise<void> {
  const doc = view.state.doc;
  const cursor = view.state.selection.main.head;
  const origin = point(view);
  const result = await ask(view, { kind, position });
  if (view.state.doc !== doc || view.state.selection.main.head !== cursor || (result?.kind !== "definition" && result?.kind !== "references")) return;
  if (kind === "definition" && result.locations.length === 1) api(view)?.navigate(result.locations[0]!, origin);
  else api(view)?.locations(kind === "definition" ? "Definitions" : "References", result.locations, result.truncated, origin);
}

function quickFixes(view: EditorView, chosen?: { from: number; to: number; code: number }): void {
  if (view.state.readOnly) return;
  let diagnostic = chosen;
  const position = view.state.selection.main.head;
  const line = view.state.doc.lineAt(position);
  if (!diagnostic)
    forEachDiagnostic(view.state, (item, from, to) => {
      if (!diagnostic && from <= line.to && to >= line.from && item.source?.startsWith("TS")) diagnostic = { from, to, code: Number(item.source.slice(2)) };
    });
  if (!diagnostic) {
    api(view)?.fixes([]);
    return;
  }
  const doc = view.state.doc;
  void ask(view, { kind: "fixes", ...diagnostic }).then((result) => {
    if (result?.kind === "fixes" && view.state.doc === doc) api(view)?.fixes(result.fixes);
  });
}

class Intelligence {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private signatureTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private alive = true;

  constructor(readonly view: EditorView) {}

  update(update: ViewUpdate): void {
    if (update.docChanged) this.refresh();
    if (update.docChanged || update.selectionSet) this.parameters();
  }

  refresh(): void {
    clearTimeout(this.timer);
    const generation = ++this.generation;
    this.timer = setTimeout(() => void this.analyze(generation), 350);
  }

  private async analyze(generation: number): Promise<void> {
    const doc = this.view.state.doc;
    const result = await ask(this.view, { kind: "analysis" });
    if (!this.alive || generation !== this.generation || doc !== this.view.state.doc || result?.kind !== "analysis") return;
    const items: Diagnostic[] = result.diagnostics.map((item) => ({
      from: item.from,
      to: item.to,
      severity: item.severity,
      message: item.message,
      source: `TS${item.code}`,
      actions: this.view.state.readOnly ? [] : [{ name: "Quick fixes", apply: (view, from, to) => quickFixes(view, { from, to, code: item.code }) }],
    }));
    this.view.dispatch(setDiagnostics(this.view.state, items));
    api(this.view)?.analysis(result);
  }

  private parameters(): void {
    clearTimeout(this.signatureTimer);
    const position = this.view.state.selection.main.head;
    const before = this.view.state.sliceDoc(Math.max(0, position - 300), position);
    if (!before.includes("(") && !before.includes(",")) return;
    const doc = this.view.state.doc;
    this.signatureTimer = setTimeout(() => {
      void ask(this.view, { kind: "signature", position }).then((result) => {
        if (!this.alive || doc !== this.view.state.doc || position !== this.view.state.selection.main.head || result?.kind !== "signature") return;
        const info = result.info;
        this.view.dispatch({ effects: setSignature.of(info ? { pos: position, above: false, create: () => ({ dom: information(info.label, info.documentation, info.parameter) }) } : null) });
      });
    }, 220);
  }

  destroy(): void {
    this.alive = false;
    clearTimeout(this.timer);
    clearTimeout(this.signatureTimer);
  }
}

const intelligence = ViewPlugin.fromClass(Intelligence);

const complete: CompletionSource = async (context) => {
  const word = context.matchBefore(/[\p{ID_Continue}$]*/u);
  if (!context.explicit && !word?.text && context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos) !== ".") return null;
  if (!context.view) return null;
  const result = await ask(context.view, { kind: "completion", position: context.pos });
  if (context.aborted || result?.kind !== "completion") return null;
  return {
    from: result.from,
    to: result.to,
    options: result.options.map((option) => ({
      label: option.label,
      type: option.type,
      detail: option.detail,
      apply: (view, completion, from, to) =>
        view.dispatch({
          ...insertCompletionText(view.state, option.insertText, from + option.replace.from - result.from, to + option.replace.to - result.to),
          annotations: pickedCompletion.of(completion),
        }),
    })),
  };
};

const hover = hoverTooltip(
  async (view, position) => {
    const doc = view.state.doc;
    const result = await ask(view, { kind: "hover", position });
    if (view.state.doc !== doc || result?.kind !== "hover" || !result.info) return null;
    const info = result.info;
    return { pos: info.from, end: info.to, above: true, create: () => ({ dom: information(info.display, info.documentation) }) };
  },
  { hoverTime: 350 },
);

const linkAt = StateEffect.define<number | null>();
const link = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    if (transaction.docChanged) value = Decoration.none;
    for (const effect of transaction.effects)
      if (effect.is(linkAt)) {
        const word = effect.value === null ? null : transaction.state.wordAt(effect.value);
        value = word ? Decoration.set([Decoration.mark({ class: "cm-definition-link" }).range(word.from, word.to)]) : Decoration.none;
      }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const pointer = EditorView.domEventHandlers({
  mousemove(event, view) {
    if (!api(view)) return;
    const position = event.metaKey || event.ctrlKey ? view.posAtCoords({ x: event.clientX, y: event.clientY }) : null;
    view.dispatch({ effects: linkAt.of(position) });
  },
  mouseleave(_event, view) {
    view.dispatch({ effects: linkAt.of(null) });
  },
  keyup(event, view) {
    if (!event.metaKey && !event.ctrlKey) view.dispatch({ effects: linkAt.of(null) });
  },
  mousedown(event, view) {
    if (!api(view) || event.button !== 0 || (!event.metaKey && !event.ctrlKey)) return false;
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (position === null || !view.state.wordAt(position)) return false;
    event.preventDefault();
    view.dispatch({ selection: { anchor: position }, effects: linkAt.of(null) });
    void navigate(view, "definition", position);
    return true;
  },
  contextmenu(event, view) {
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (position !== null && view.state.selection.main.empty) view.dispatch({ selection: { anchor: position } });
    return false;
  },
});

const command = (run: (view: EditorView) => void) => (view: EditorView) => {
  if (!api(view)) return false;
  run(view);
  return true;
};
export const intelligenceExtensions = [
  tooltips({ position: "absolute", tooltipSpace: (view) => view.dom.getBoundingClientRect() }),
  intelligence,
  signature,
  hover,
  link,
  pointer,
  autocompletion({ override: [complete] }),
  keymap.of([
    { key: "F12", run: command((view) => void navigate(view, "definition")) },
    { key: "Shift-F12", run: command((view) => void navigate(view, "references")) },
    { key: "Mod-.", run: command(quickFixes) },
    { key: "Mod-Shift-m", run: command((view) => api(view)?.problems()) },
    { key: "Alt-ArrowLeft", run: (view) => api(view)?.back() ?? false },
    { key: "Alt-ArrowRight", run: (view) => api(view)?.forward() ?? false },
    {
      key: "Escape",
      run: (view) => {
        if (!view.state.field(signature)) return false;
        view.dispatch({ effects: setSignature.of(null) });
        return true;
      },
    },
    ...completionKeymap,
  ]),
];

export function bindIntelligence(view: EditorView, get: () => EditorIntelligence | undefined): CodeEditorActions {
  bindings.set(view, get);
  refreshIntelligence(view);
  return {
    definition: () => void navigate(view, "definition"),
    references: () => void navigate(view, "references"),
    outline: () => api(view)?.outline(),
    problems: () => api(view)?.problems(),
    quickFixes: () => quickFixes(view),
    point: () => point(view),
    focus: () => view.focus(),
    refresh: () => refreshIntelligence(view),
  };
}

export function refreshIntelligence(view: EditorView): void {
  if (api(view)) view.plugin(intelligence)?.refresh();
}

export function releaseIntelligence(view: EditorView): void {
  bindings.delete(view);
}
