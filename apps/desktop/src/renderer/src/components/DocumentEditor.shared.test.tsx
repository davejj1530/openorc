import { createRef, type ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentEditor, type DocumentEditorHandle } from "./DocumentEditor";
import { finishImageImport, readStagedImage } from "../lib/image-imports";

vi.mock("./ThreadImages", () => ({ ThreadMedia: ({ children }: { children: ReactNode }) => children, useThreadMedia: () => ({ openImage: () => {} }) }));
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));
vi.mock("../lib/image-imports", async (original) => ({ ...(await original<object>()), finishImageImport: vi.fn(), readStagedImage: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("shows a device image as unavailable without loading or importing it", async () => {
  const editor = createRef<DocumentEditorHandle>();
  const view = render(
    <DocumentEditor ref={editor} value="![Diagram](openorc-pending://device-image)" onChange={() => {}} imageUnavailableReason="Images aren’t available in shared task documents yet." />,
  );
  await screen.findByRole("img", { name: "Image unavailable" });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Insert image" }).disabled).toBe(true);
  expect(view.container.querySelector("img[src]")).toBeNull();
  await act(async () => {
    expect(await editor.current?.flush()).toBe(false);
  });
  expect(readStagedImage).not.toHaveBeenCalled();
  expect(finishImageImport).not.toHaveBeenCalled();
});
