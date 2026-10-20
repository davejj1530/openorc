import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLayout } from "../lib/layout";
import { ThreadMedia, ThreadRichText } from "./ThreadImages";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const scope = { kind: "thread", id: "thread-1" } as const;

function reply(text: string) {
  return render(
    <ThreadMedia scopeKey="thread-1" basePath="/Users/david/flyers (1)" fileScope={scope}>
      <ThreadRichText>{text}</ThreadRichText>
    </ThreadMedia>,
  );
}

it("shows a Codex file citation as a link that opens the file in the panel", async () => {
  const openFile = vi.spyOn(useLayout.getState(), "openFile").mockImplementation(() => {});
  reply('Updated the flyer.\n\n:codex-file-citation{path="/Users/david/flyers (1)/output/pdf/01_toby_revised.pdf" purpose="output"}\n\nLayout verified.');

  const link = await screen.findByRole("link", { name: "01_toby_revised.pdf" });
  expect(document.body.textContent).not.toContain("codex-file-citation");
  fireEvent.click(link);
  expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ path: "/Users/david/flyers (1)/output/pdf/01_toby_revised.pdf", scope }));
});

it("keeps a cited line range and drops a citation without a path", async () => {
  const openFile = vi.spyOn(useLayout.getState(), "openFile").mockImplementation(() => {});
  reply('See :codex-file-citation{path="/repo/src/app.ts" line_start="12" line_end="18"} and :codex-file-citation{purpose="source"} here.');

  fireEvent.click(await screen.findByRole("link", { name: "app.ts" }));
  expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ path: "/repo/src/app.ts", line: 12, endLine: 18 }));
  expect(document.body.textContent).toBe("See app.ts and  here.");
});
