import { act, renderHook } from "@testing-library/react";
import { Editor } from "@tiptap/react";
import { expect, it, vi } from "vitest";
import { documentExtensions } from "./document-schema";
import { useDocumentCommands } from "./use-document-commands";

it("chooses a slash command by keyboard and clears its query", () => {
  const editor = new Editor({ extensions: documentExtensions(), content: "/ima", contentType: "markdown" });
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 20, right: 20, top: 10, bottom: 20 });
  const pickImage = vi.fn();
  const hook = renderHook(() => useDocumentCommands(editor, false, pickImage));
  try {
    editor.commands.setTextSelection(5);
    act(() => hook.result.current.syncMenu(editor));
    expect(hook.result.current.menu?.query).toBe("ima");
    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    act(() => expect(hook.result.current.handleKeyDown(enter)).toBe(true));
    expect(enter.defaultPrevented).toBe(true);
    expect(pickImage).toHaveBeenCalledOnce();
    expect(editor.getMarkdown()).toBe("");
    expect(hook.result.current.menu).toBeNull();
  } finally {
    hook.unmount();
    editor.destroy();
  }
});

it("dismisses one query on Escape without suppressing later queries", () => {
  const editor = new Editor({ extensions: documentExtensions(), content: "/ima", contentType: "markdown" });
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 20, right: 20, top: 10, bottom: 20 });
  const hook = renderHook(() => useDocumentCommands(editor, false, vi.fn()));
  try {
    editor.commands.setTextSelection(5);
    act(() => hook.result.current.syncMenu(editor));
    act(() => {
      hook.result.current.handleKeyDown(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    act(() => hook.result.current.syncMenu(editor));
    expect(hook.result.current.menu).toBeNull();
    act(() => {
      editor.commands.setContent("/text", { contentType: "markdown" });
    });
    editor.commands.setTextSelection(6);
    act(() => hook.result.current.syncMenu(editor));
    expect(hook.result.current.menu?.query).toBe("text");
  } finally {
    hook.unmount();
    editor.destroy();
  }
});
