import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FolderPath, type BinaryFile, type SignedFileUrl } from "@openorc/protocol";
import { noteFile } from "../lib/use-file-buffer";
import { BinaryView, revealLabel } from "./BinaryView";

vi.mock("../lib/use-file-buffer", () => ({ noteFile: vi.fn() }));
const shell = { platform: "darwin", openFile: vi.fn(async () => ""), revealFile: vi.fn() };
beforeEach(() => Object.defineProperty(window, "openorc", { value: shell, configurable: true }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const url = (name: string) => `openorc-file://file/?path=%2Frepo%2Fdocs%2F${name}&sig=0123&v=1` as SignedFileUrl;
const file = (media: BinaryFile["media"], name: string): BinaryFile => ({
  root: "/repo",
  path: FolderPath.parse(`docs/${name}`),
  absolutePath: `/repo/docs/${name}`,
  size: 123_456,
  media,
  mime: "x/y",
  url: url(name),
});

it("shows each media kind in its own element, loading only the signed URL, with controls and never autoplay", () => {
  const { container } = render(<BinaryView file={file("pdf", "deck.pdf")} />);
  expect(container.querySelector("iframe")?.getAttribute("src")).toBe(url("deck.pdf"));
  cleanup();
  render(<BinaryView file={file("image", "photo.png")} />);
  expect(screen.getByRole("img", { name: "photo.png" }).getAttribute("src")).toBe(url("photo.png"));
  cleanup();
  for (const [media, name] of [
    ["video", "clip.mp4"],
    ["audio", "song.mp3"],
  ] as const) {
    const { container: page } = render(<BinaryView file={file(media, name)} />);
    const element = page.querySelector(media)!;
    expect(element.getAttribute("src")).toBe(url(name));
    expect([element.hasAttribute("controls"), element.hasAttribute("autoplay")]).toEqual([true, false]);
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
  }
});

it("shows a file of no particular kind by name and size, with Open and Show in Finder", async () => {
  render(<BinaryView file={file("other", "archive.zip")} />);
  expect(screen.getByText("archive.zip")).toBeTruthy();
  expect(screen.getByText("121 KB")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(shell.openFile).toHaveBeenCalledWith(url("archive.zip"));
  await waitFor(() => expect(noteFile).toHaveBeenCalledWith(expect.objectContaining({ root: "/repo", path: "docs/archive.zip" }), null));
  fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
  expect(shell.revealFile).toHaveBeenCalledWith("/repo/docs/archive.zip");
});

it("replaces media that fails to load with one line and the same two buttons", () => {
  render(<BinaryView file={file("image", "photo.png")} />);
  fireEvent.error(screen.getByRole("img"));
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Could not show this file.");
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Open", "Show in Finder"]);
});

it("leaves the file's quiet line saying why the default app did not open it, in main's words or its own when main never answered", async () => {
  shell.openFile.mockResolvedValueOnce("Programs can’t be opened from here.");
  render(<BinaryView file={file("other", "tool")} />);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  await waitFor(() => expect(noteFile).toHaveBeenCalledWith(expect.objectContaining({ path: "docs/tool" }), "Programs can’t be opened from here."));
  shell.openFile.mockRejectedValueOnce(new Error("no bridge"));
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  await waitFor(() => expect(noteFile).toHaveBeenLastCalledWith(expect.anything(), "Could not open this file."));
});

it("names the platform's file manager", () => {
  expect([revealLabel("darwin"), revealLabel("win32"), revealLabel("linux")]).toEqual(["Show in Finder", "Show in Explorer", "Show in folder"]);
});
