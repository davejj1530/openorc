import { act, renderHook } from "@testing-library/react";
import { Editor } from "@tiptap/react";
import { expect, it, vi } from "vitest";
import { documentExtensions } from "./document-schema";
import { useDocumentMode } from "./use-document-mode";

it("restores the rich selection when source Markdown has not changed", () => {
  const editor = new Editor({ extensions: documentExtensions(), content: "Hello world", contentType: "markdown" });
  const hook = renderHook(() => useDocumentMode(editor, "Hello world", vi.fn(), true, vi.fn()));
  try {
    editor.commands.setTextSelection(4);
    act(() => hook.result.current.switchMode());
    expect(hook.result.current.source).toBe(true);
    act(() => hook.result.current.switchMode());
    expect(hook.result.current.source).toBe(false);
    expect(editor.state.selection.from).toBe(4);
  } finally {
    hook.unmount();
    editor.destroy();
  }
});

it("keeps a source edit when returning to rich text", () => {
  const editor = new Editor({ extensions: documentExtensions(), content: "Hello", contentType: "markdown" });
  const onChange = vi.fn();
  const hook = renderHook(({ value }: { value: string }) => useDocumentMode(editor, value, onChange, true, vi.fn()), { initialProps: { value: "Hello" } });
  try {
    act(() => hook.result.current.switchMode());
    act(() => hook.result.current.emitSource("## Edited"));
    hook.rerender({ value: "## Edited" });
    act(() => hook.result.current.switchMode());
    expect(editor.getMarkdown()).toContain("## Edited");
    expect(onChange).toHaveBeenCalledWith("## Edited");
  } finally {
    hook.unmount();
    editor.destroy();
  }
});
