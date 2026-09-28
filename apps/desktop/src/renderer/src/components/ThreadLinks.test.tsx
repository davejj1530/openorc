import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadLink, ThreadMedia } from "./ThreadImages";
import { useLayout } from "../lib/layout";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("hands web links directly to native navigation without a confirmation", () => {
  const openExternal = vi.fn();
  vi.stubGlobal("openorc", { openExternal });
  render(<ThreadLink href="https://example.com/docs">Documentation</ThreadLink>);
  const link = screen.getByRole("link");
  expect(fireEvent.click(link)).toBe(true);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(openExternal).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("still opens local source citations in the file panel", () => {
  const revealFile = vi.fn();
  vi.stubGlobal("openorc", { revealFile });
  render(
    <ThreadMedia scopeKey="thread:a" fileScope={{ kind: "thread", id: "a" }}>
      <ThreadLink href="/tmp/example.ts#L12">Source</ThreadLink>
    </ThreadMedia>,
  );
  fireEvent.click(screen.getByRole("link"));
  expect(useLayout.getState().selectedFile).toMatchObject({ path: "/tmp/example.ts", line: 12, scope: { kind: "thread", id: "a" } });
  expect(revealFile).not.toHaveBeenCalled();
});
