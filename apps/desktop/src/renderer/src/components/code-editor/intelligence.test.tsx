import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { acceptCompletion, currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { diagnosticCount } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { FolderPath, type EditorResult } from "@openorc/protocol";
import { CodeEditor } from "./CodeEditor";
import type { CodeEditorProps, EditorIntelligence } from "./types";

afterEach(cleanup);
const empty: EditorResult = { kind: "analysis", diagnostics: [], symbols: [] };
const target = { path: FolderPath.parse("math.ts"), from: 16, to: 22, line: 1, column: 17, endLine: 1, endColumn: 23, preview: "export function double" };
const definition: EditorResult = { kind: "definition", locations: [target], truncated: false };
const text = 'import { double } from "./math.js";\nconst answer = double(2);';

function setup(overrides: Partial<CodeEditorProps> = {}) {
  const api = {
    query: vi.fn<EditorIntelligence["query"]>().mockResolvedValue(empty),
    navigate: vi.fn(),
    locations: vi.fn(),
    analysis: vi.fn(),
    fixes: vi.fn(),
    outline: vi.fn(),
    problems: vi.fn(),
    error: vi.fn(),
    back: vi.fn(() => true),
    forward: vi.fn(() => true),
  } satisfies EditorIntelligence;
  const props: CodeEditorProps = { sessionKey: crypto.randomUUID(), path: "main.ts", text, readOnly: false, reveal: null, onChange: vi.fn(), onSave: vi.fn(), intelligence: api, ...overrides };
  const rendered = render(<CodeEditor {...props} />);
  const node = rendered.container.querySelector<HTMLElement>(".cm-editor");
  const view = node && EditorView.findFromDOM(node);
  if (!view) throw new Error("Expected the code editor");
  return { view, api, props, rendered };
}

it("handles F12 against the current buffer and navigates to the exact imported symbol", async () => {
  const { view, api } = setup();
  api.query.mockImplementation(async (query) => (query.kind === "definition" ? definition : empty));
  const position = text.lastIndexOf("double") + 2;
  act(() => view.dispatch({ selection: { anchor: position } }));
  expect(fireEvent.keyDown(view.contentDOM, { key: "F12", keyCode: 123 })).toBe(false);
  await waitFor(() => expect(api.navigate).toHaveBeenCalledWith(target, { line: 2, column: 18 }));
  expect(api.query).toHaveBeenCalledWith({ kind: "definition", position }, text);
});

it("discards a definition response after typing or moving the cursor", async () => {
  const { view, api } = setup();
  const pending = Promise.withResolvers<EditorResult>();
  api.query.mockImplementation((query) => (query.kind === "definition" ? pending.promise : Promise.resolve(empty)));
  fireEvent.keyDown(view.contentDOM, { key: "F12", keyCode: 123 });
  act(() => view.dispatch({ selection: { anchor: 2 } }));
  await act(async () => pending.resolve(definition));
  expect(api.navigate).not.toHaveBeenCalled();
  expect(api.locations).not.toHaveBeenCalled();
});

it("discards diagnostics computed for text that changed while the service was working", async () => {
  const { view, api } = setup();
  const pending = Promise.withResolvers<EditorResult>();
  api.query.mockImplementation((query) => (query.kind === "analysis" ? pending.promise : Promise.resolve(empty)));
  await waitFor(() => expect(api.query).toHaveBeenCalledWith({ kind: "analysis" }, text));
  act(() => view.dispatch({ changes: { from: 0, insert: "// changed\n" } }));
  await act(async () => pending.resolve({ kind: "analysis", diagnostics: [{ from: 0, to: 5, code: 2552, severity: "error", message: "Old error" }], symbols: [] }));
  expect(diagnosticCount(view.state)).toBe(0);
  expect(api.analysis).not.toHaveBeenCalled();
});

it("replaces the whole completion word when the caret is in its middle", async () => {
  const source = "object.firstN";
  const { view, api } = setup({ text: source });
  api.query.mockImplementation(async (query): Promise<EditorResult> =>
    query.kind === "completion"
      ? { kind: "completion", from: 7, to: source.length, options: [{ label: "firstName", type: "property", insertText: "firstName", detail: "property", replace: { from: 7, to: source.length } }] }
      : empty,
  );
  act(() => {
    view.focus();
    view.dispatch({ selection: { anchor: 10 } });
    startCompletion(view);
  });
  await waitFor(() => expect(currentCompletions(view.state).map((item) => item.label)).toContain("firstName"));
  await waitFor(() => {
    let accepted = false;
    act(() => {
      accepted = acceptCompletion(view);
    });
    expect(accepted).toBe(true);
  });
  expect(view.state.doc.toString()).toBe("object.firstName");
});

it("leaves read-only buffers unchanged when Quick fixes is invoked", () => {
  const { view, api } = setup({ readOnly: true });
  fireEvent.keyDown(view.contentDOM, { key: ".", ctrlKey: true });
  expect(api.query).not.toHaveBeenCalled();
  expect(view.state.doc.toString()).toBe(text);
});

it("reveals a symbol's columns and restores keyboard focus", () => {
  const { view } = setup({ reveal: { start: 2, end: 2, column: 16, endColumn: 22 } });
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("double");
  expect(document.activeElement).toBe(view.contentDOM);
});
