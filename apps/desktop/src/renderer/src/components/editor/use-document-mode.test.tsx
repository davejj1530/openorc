import { act, renderHook } from "@testing-library/react";
import { Editor } from "@tiptap/react";
import { expect, it, vi } from "vitest";
import { documentExtensions } from "./document-schema";
import { useDocumentMode } from "./use-document-mode";

function editorWith(markdown: string) {
  return new Editor({ extensions: documentExtensions(), content: markdown, contentType: "markdown" });
}

it("leaves the document and caret alone when the value only restates it", () => {
  const editor = editorWith("- First item\n- Second item");
  const hook = renderHook(({ value }: { value: string }) => useDocumentMode(editor, value, vi.fn()), { initialProps: { value: "- First item\n- Second item" } });
  try {
    editor.commands.setTextSelection(6);
    const before = editor.state.doc;
    hook.rerender({ value: "* First item\n* Second item" });
    expect(editor.state.doc).toBe(before);
    expect(editor.state.selection.from).toBe(6);
  } finally {
    hook.unmount();
    editor.destroy();
  }
});

it("shows an outside change without adding it to undo, keeping the caret near where it was", () => {
  const editor = editorWith("Hello world");
  const onChange = vi.fn();
  const hook = renderHook(({ value }: { value: string }) => useDocumentMode(editor, value, onChange), { initialProps: { value: "Hello world" } });
  try {
    editor.commands.setTextSelection(4);
    hook.rerender({ value: "Hello there, world" });
    expect(editor.getMarkdown()).toBe("Hello there, world");
    expect(editor.state.selection.from).toBe(4);
    expect(editor.can().undo()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    hook.unmount();
    editor.destroy();
  }
});

it("returns to rich text with the Markdown edited in source", () => {
  const editor = editorWith("Hello");
  const onChange = vi.fn();
  const hook = renderHook(({ value }: { value: string }) => useDocumentMode(editor, value, onChange), { initialProps: { value: "Hello" } });
  try {
    act(() => hook.result.current.toggleSource());
    expect(hook.result.current.source).toBe(true);
    act(() => hook.result.current.emitSource("## Edited <!-- note -->"));
    hook.rerender({ value: "## Edited <!-- note -->" });
    expect(editor.getMarkdown()).toBe("Hello");
    act(() => hook.result.current.toggleSource());
    expect(hook.result.current.source).toBe(false);
    expect(editor.getMarkdown().trimEnd()).toBe("## Edited <!-- note -->");
    expect(onChange).toHaveBeenCalledWith("## Edited <!-- note -->");
  } finally {
    hook.unmount();
    editor.destroy();
  }
});
