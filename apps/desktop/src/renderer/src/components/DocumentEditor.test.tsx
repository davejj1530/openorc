import { createRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentEditor, type DocumentEditorHandle } from "./DocumentEditor";

vi.mock("./ThreadImages", () => ({
  ThreadMedia: ({ children }: { children: React.ReactNode }) => children,
  ThreadRichText: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));

afterEach(cleanup);

it("preserves an unsupported draft in source mode, then opens its edited Markdown in rich mode", async () => {
  const editor = createRef<DocumentEditorHandle>();
  function Draft() {
    const [value, setValue] = useState("<!-- Keep this comment -->");
    return <DocumentEditor ref={editor} value={value} onChange={setValue} />;
  }

  render(<Draft />);
  let source = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Task description Markdown" });
  expect(source.value).toBe("<!-- Keep this comment -->");
  source.focus();
  source.setSelectionRange(5, 5);
  fireEvent.select(source);
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit source" }));
  source = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Task description Markdown" });
  expect(source.selectionStart).toBe(5);
  fireEvent.click(screen.getByRole("button", { name: "Rich text" }));
  expect(source.value).toBe("<!-- Keep this comment -->");
  expect(screen.getByRole("status").textContent).toContain("preserved in Markdown mode");

  fireEvent.change(source, { target: { value: "## Edited draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Rich text" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Task description" }).textContent).toContain("Edited draft"));
  await act(async () => expect(await editor.current?.flush()).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Task description Markdown" }).value).toBe("## Edited draft");
});
