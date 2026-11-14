// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerFile } from "./ComposerFile";

afterEach(cleanup);
const attachment = { path: "/hosted/files/example/notes.pdf", name: "notes.pdf", bytes: 245_760, url: null };

it("shows progress inside the named file without an extra composer message", () => {
  const remove = vi.fn();
  render(<ComposerFile attachment={attachment} state={{ kind: "uploading", percent: 64 }} remove={remove} />);
  const progress = screen.getByRole("progressbar", { name: "Uploading notes.pdf" });
  expect(progress.getAttribute("aria-valuenow")).toBe("64");
  expect(progress.closest(".composer-file")).not.toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove notes.pdf" }));
  expect(remove).toHaveBeenCalledOnce();
});

it("shows a refusal once and retries only that file", () => {
  const retry = vi.fn();
  const message = "This file didn't finish uploading. Retry or remove it.";
  render(
    <>
      <ComposerFile attachment={attachment} state={{ kind: "failed", message, retry }} remove={() => undefined} />
      <ComposerFile attachment={{ ...attachment, name: "ready.pdf" }} remove={() => undefined} />
    </>,
  );
  expect(screen.getAllByText(message)).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledOnce();
});

it("keeps an oversize chip removable without offering a retry of the same file", () => {
  render(<ComposerFile attachment={attachment} state={{ kind: "failed", message: "Keep files under 500 MB.", retry: null }} remove={() => undefined} />);
  expect(screen.getByText("Keep files under 500 MB.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.getByRole("button", { name: "Remove notes.pdf" })).toBeTruthy();
});
