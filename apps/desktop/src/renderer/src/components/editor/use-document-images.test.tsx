import { act, renderHook, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/react";
import { afterEach, expect, it, vi } from "vitest";
import { documentExtensions } from "./document-schema";
import { useDocumentImages } from "./use-document-images";

const imports = vi.hoisted(() => ({ stageImage: vi.fn(), finishImageImport: vi.fn() }));
vi.mock("../../lib/image-imports", () => imports);

afterEach(() => {
  imports.stageImage.mockReset();
  imports.finishImageImport.mockReset();
});

it("keeps the insertion point while staging and replaces the pending image when flushed", async () => {
  let finishStage!: (id: string) => void;
  imports.stageImage.mockImplementation(() => new Promise<string>((resolve) => (finishStage = resolve)));
  imports.finishImageImport.mockResolvedValue({ path: "attachments/saved.png", url: "openorc-asset://attachments/saved.png" });
  const editor = new Editor({ extensions: documentExtensions(), content: "Start end", contentType: "markdown" });
  const readiness = vi.fn();
  const errors = vi.fn();
  const hook = renderHook(() => useDocumentImages(readiness, errors));
  try {
    editor.commands.setTextSelection(6);
    act(() => hook.result.current.stage(editor, [new File(["image"], "image.png", { type: "image/png" })]));
    expect(readiness).toHaveBeenLastCalledWith(false);
    act(() => {
      editor.commands.insertContentAt(1, "New ");
    });
    await act(async () => finishStage("staged"));
    await waitFor(() => expect(editor.getMarkdown()).toContain("openorc-pending://staged"));
    // The image takes a paragraph of its own between the split text, and writing continues after it.
    expect(editor.state.doc.children.map((block) => block.children.map((node) => node.text ?? node.type.name))).toEqual([["New Start"], ["image"], [" end"]]);
    expect(editor.state.selection.$from.parent.textContent).toBe(" end");
    expect(editor.state.selection.$from.parentOffset).toBe(0);

    await act(async () => expect(await hook.result.current.flush(editor, false, editor.getMarkdown())).toBe(true));
    expect(editor.getMarkdown()).toContain("openorc-asset://attachments/saved.png");
    expect(readiness).toHaveBeenLastCalledWith(true);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    hook.unmount();
    editor.destroy();
  }
});

it("releases its transaction listener on teardown and ignores a late staged image", async () => {
  let finishStage!: (id: string) => void;
  imports.stageImage.mockImplementation(() => new Promise<string>((resolve) => (finishStage = resolve)));
  const editor = new Editor({ extensions: documentExtensions(), content: "Draft", contentType: "markdown" });
  const detached = vi.spyOn(editor, "off");
  const hook = renderHook(() => useDocumentImages(vi.fn(), vi.fn()));
  act(() => hook.result.current.stage(editor, [new File(["image"], "image.png", { type: "image/png" })]));
  hook.unmount();
  expect(detached).toHaveBeenCalledWith("transaction", expect.any(Function));
  await act(async () => finishStage("late"));
  expect(editor.getMarkdown()).toBe("Draft");
  editor.destroy();
});

it("reports staging failure and clears the busy state", async () => {
  imports.stageImage.mockRejectedValue(new Error("Image cannot be staged"));
  const editor = new Editor({ extensions: documentExtensions(), content: "Draft", contentType: "markdown" });
  const readiness = vi.fn();
  const errors = vi.fn();
  const hook = renderHook(() => useDocumentImages(readiness, errors));
  try {
    act(() => hook.result.current.stage(editor, [new File(["image"], "image.png", { type: "image/png" })]));
    await waitFor(() => expect(errors).toHaveBeenCalledWith("Image cannot be staged"));
    expect(hook.result.current.busy).toBe(false);
    expect(readiness.mock.calls.map(([ready]) => ready)).toEqual([false, true]);
  } finally {
    hook.unmount();
    editor.destroy();
  }
});
