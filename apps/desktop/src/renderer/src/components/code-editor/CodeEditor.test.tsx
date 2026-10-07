import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { undo, undoDepth } from "@codemirror/commands";
import { language } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useAppShortcuts } from "../../lib/app-shortcuts";
import { useRouter } from "../../lib/router";
import { useUi } from "../../lib/ui";
import { CodeEditor } from "./CodeEditor";
import { closeEditorSession, findSession, keepSession } from "./sessions";
import type { CodeEditorProps } from "./types";

let key = 0;
let props: CodeEditorProps;

beforeEach(() => {
  key += 1;
  props = { sessionKey: `buffer-${key}`, path: "notes.txt", text: "one\ntwo\nthree\n", readOnly: false, reveal: null, onChange: vi.fn(), onSave: vi.fn() };
  useRouter.setState({ route: { view: "thread", threadId: "t1" }, threadIds: ["t1"], history: [{ view: "inbox" }], future: [{ view: "memory" }] });
  useUi.setState({ palette: false });
});
afterEach(cleanup);

function mount(overrides: Partial<CodeEditorProps> = {}) {
  props = { ...props, ...overrides };
  const rendered = render(<CodeEditor {...props} />);
  const view = () => EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!)!;
  const rerender = (next: Partial<CodeEditorProps>) => {
    props = { ...props, ...next };
    rendered.rerender(<CodeEditor {...props} />);
  };
  return { view, rerender, unmount: rendered.unmount };
}

const type = (view: EditorView, at: number, insert: string) => act(() => view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, userEvent: "input.type" }));
const press = (view: EditorView, init: KeyboardEventInit) => fireEvent.keyDown(view.contentDOM, init);

it("reports every change in the same task, with the file's own line breaks", () => {
  const { view } = mount({ text: "one\r\ntwo\r\n" });
  type(view(), 3, "!");
  expect(props.onChange).toHaveBeenLastCalledWith("one!\r\ntwo\r\n");
  act(() => {
    undo(view());
  });
  expect(props.onChange).toHaveBeenLastCalledWith("one\r\ntwo\r\n");
});

it("takes a new text as one undo step of its own, even right beside the typing", () => {
  const { view, rerender } = mount();
  type(view(), 3, "!");
  rerender({ text: "one!, changed\ntwo\nthree\n" });
  expect(view().state.doc.toString()).toBe("one!, changed\ntwo\nthree\n");
  expect(props.onChange).toHaveBeenCalledTimes(1);
  act(() => {
    undo(view());
  });
  expect(view().state.doc.toString()).toBe("one!\ntwo\nthree\n");
  expect(props.onChange).toHaveBeenLastCalledWith("one!\ntwo\nthree\n");
});

it("changes only the range that differs, so the caret stays where it was", () => {
  const { view, rerender } = mount();
  act(() => view().dispatch({ selection: { anchor: 2 } }));
  rerender({ text: "one\ntwo\nthree, changed\n" });
  expect(view().state.selection.main.head).toBe(2);
});

it("changes nothing for a text equal to its last report, so typing stays one undo step across the caller's renders", () => {
  const { view, rerender } = mount();
  type(view(), 3, "!");
  rerender({ text: "one!\ntwo\nthree\n" });
  type(view(), 4, "?");
  rerender({ text: "one!?\ntwo\nthree\n" });
  act(() => {
    undo(view());
  });
  expect(view().state.doc.toString()).toBe("one\ntwo\nthree\n");
});

it("handles Cmd+S, Shift+Option+F, Cmd+F and Cmd+] itself, so App's shortcuts stay quiet", () => {
  renderHook(() => useAppShortcuts(undefined));
  const onFormat = vi.fn();
  const { view } = mount({ onFormat });
  expect(press(view(), { key: "s", keyCode: 83, ctrlKey: true }), "Cmd+S is claimed").toBe(false);
  expect(props.onSave).toHaveBeenCalledOnce();
  expect(press(view(), { key: "Ï", keyCode: 70, shiftKey: true, altKey: true }), "Shift+Option+F is claimed").toBe(false);
  expect(onFormat).toHaveBeenCalledOnce();
  expect(press(view(), { key: "]", keyCode: 221, ctrlKey: true }), "Cmd+] is claimed").toBe(false);
  expect(view().state.doc.line(1).text).toBe("  one");
  expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "t1" });
  expect(press(view(), { key: "f", keyCode: 70, ctrlKey: true }), "Cmd+F is claimed").toBe(false);
  expect(view().dom.querySelector(".cm-search")).not.toBeNull();
});

it("leaves message search closed when Cmd+F opens the editor's own find", () => {
  renderHook(() => useAppShortcuts(undefined));
  const { view } = mount();
  press(view(), { key: "f", keyCode: 70, ctrlKey: true });
  expect(view().dom.querySelector(".cm-search")).not.toBeNull();
  expect(useUi.getState().palette).toBe(false);
});

it("lets Shift+Option+F through when the caller has no formatter", () => {
  const { view } = mount();
  expect(press(view(), { key: "Ï", keyCode: 70, shiftKey: true, altKey: true })).toBe(true);
});

it("keeps a buffer's history across unmounts until its session is closed", () => {
  const first = mount();
  type(first.view(), 3, "!");
  first.unmount();
  const again = mount({ text: "one!\ntwo\nthree\n" });
  expect(undoDepth(again.view().state)).toBe(1);
  again.unmount();
  closeEditorSession(props.sessionKey);
  const fresh = mount({ text: "one!\ntwo\nthree\n" });
  expect(undoDepth(fresh.view().state)).toBe(0);
});

it("refuses typing in a read-only buffer", () => {
  const { view } = mount({ readOnly: true });
  expect(press(view(), { key: "]", keyCode: 221, ctrlKey: true })).toBe(true);
  expect(view().state.doc.toString()).toBe("one\ntwo\nthree\n");
  expect(props.onChange).not.toHaveBeenCalled();
});

it("selects cited lines once per session, not each time the buffer shows", () => {
  const reveal = { start: 2, end: 3 };
  const first = mount({ reveal });
  expect(first.view().state.selection.main).toMatchObject({ from: 4, to: 13 });
  act(() => first.view().dispatch({ selection: { anchor: 0 } }));
  first.rerender({ reveal });
  expect(first.view().state.selection.main.head).toBe(0);
  first.unmount();
  const again = mount({ reveal });
  expect(again.view().state.selection.main.head).toBe(0);
  again.rerender({ reveal: { start: 1, end: 1 } });
  expect(again.view().state.selection.main).toMatchObject({ from: 0, to: 3 });
});

it("loads a language for the file's name on demand", async () => {
  const { view } = mount({ path: "src/cart.ts", text: "export const total = 1;\n" });
  await waitFor(() => expect(view().state.facet(language)?.name).toBe("typescript"));
});

it("forgets the least recently shown session once twenty are kept", () => {
  const session = () => ({ state: EditorState.create(), scroll: null, reported: "", revealed: null });
  for (let n = 0; n < 20; n++) keepSession(`recent-${n}`, session());
  keepSession("recent-0", findSession("recent-0")!);
  keepSession("recent-20", session());
  expect(findSession("recent-0")).toBeDefined();
  expect(findSession("recent-1")).toBeUndefined();
});
