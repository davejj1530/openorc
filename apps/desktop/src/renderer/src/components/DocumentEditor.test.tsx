import { createRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/react";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentEditor, type DocumentEditorHandle } from "./DocumentEditor";
import { documentExtensions } from "./editor/document-schema";
import { LinkEditor } from "./editor/LinkEditor";

vi.mock("./ThreadImages", () => ({
  ThreadMedia: ({ children }: { children: React.ReactNode }) => children,
  useThreadMedia: () => ({ openImage: () => {} }),
}));
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));

afterEach(cleanup);

it("opens Markdown it has no rich form for in rich text, and keeps it as written", async () => {
  const onChange = vi.fn();
  render(<DocumentEditor value={"<!-- Keep this comment -->\n\nCheck <model> first."} onChange={onChange} />);
  const rich = screen.getByRole("textbox", { name: "Task description" });
  await waitFor(() => expect(rich.textContent).toContain("Check <model> first."));
  expect(rich.textContent).toContain("<!-- Keep this comment -->");
  expect(screen.queryByRole("textbox", { name: "Task description Markdown" })).toBeNull();
  // Opening a document is not an edit: nothing is rewritten or saved.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(onChange).not.toHaveBeenCalled();
});

it("switches to Markdown and back without losing a source edit", async () => {
  const editor = createRef<DocumentEditorHandle>();
  function Draft() {
    const [value, setValue] = useState("Draft");
    return <DocumentEditor ref={editor} value={value} onChange={setValue} />;
  }

  render(<Draft />);
  fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
  const source = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Task description Markdown" });
  expect(source.value).toBe("Draft");
  fireEvent.change(source, { target: { value: "## Edited draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Rich text" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Task description" }).querySelector("h2")?.textContent).toBe("Edited draft"));
  await act(async () => expect(await editor.current?.flush()).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Task description Markdown" }).value).toBe("## Edited draft");
});

it("links the selected text, reading a bare domain as a web address and refusing other schemes", () => {
  const editor = new Editor({ extensions: documentExtensions(), content: "Read the spec", contentType: "markdown" });
  const onClose = vi.fn();
  try {
    editor.commands.setTextSelection({ from: 10, to: 14 });
    render(<LinkEditor editor={editor} initial="" onClose={onClose} />);
    const input = screen.getByRole("textbox", { name: "Link URL" });
    fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toContain("web address");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "example.com/spec" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(editor.getMarkdown()).toBe("Read the [spec](https://example.com/spec)");
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    editor.destroy();
  }
});
