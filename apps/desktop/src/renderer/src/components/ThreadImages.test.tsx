import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLayout } from "../lib/layout";
import { ThreadMedia, ThreadRichText } from "./ThreadImages";

afterEach(cleanup);

it("shows a local image an agent puts in its reply inline", async () => {
  render(
    <ThreadMedia scopeKey="thread">
      <ThreadRichText>{"Here is the Royal direction:\n\n![Royal](/tmp/brand-identity/palettes/royal-project.jpg)"}</ThreadRichText>
    </ThreadMedia>,
  );
  const image = await screen.findByRole("img", { name: "Royal" });
  expect(image.getAttribute("src")).toBe(`openorc-asset://local-image/?path=${encodeURIComponent("/tmp/brand-identity/palettes/royal-project.jpg")}`);
  expect(screen.getByRole("button", { name: "View image: Royal" })).toBeTruthy();
});

it("reads a cited file as a reference when the conversation's files are elsewhere, and opens it when they are here", async () => {
  const openFile = vi.spyOn(useLayout.getState(), "openFile").mockImplementation(() => undefined);
  const reveal = vi.fn();
  vi.stubGlobal("openorc", { revealFile: reveal });
  const cited = "See [the footer](src/footer.tsx:12).";
  render(
    <ThreadMedia scopeKey="cloud" fileLinks="cite">
      <ThreadRichText>{cited}</ThreadRichText>
    </ThreadMedia>,
  );
  const reference = await screen.findByText("the footer");
  expect(reference.closest("a")).toBeNull();
  fireEvent.click(reference);
  expect(openFile).not.toHaveBeenCalled();
  expect(reveal).not.toHaveBeenCalled();
  cleanup();
  render(
    <ThreadMedia scopeKey="mirror" basePath="/mirrors/footer" fileScope={{ kind: "thread", id: "t1" }}>
      <ThreadRichText>{cited}</ThreadRichText>
    </ThreadMedia>,
  );
  fireEvent.click(await screen.findByText("the footer"));
  expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ path: "/mirrors/footer/src/footer.tsx", line: 12, scope: { kind: "thread", id: "t1" } }));
  vi.unstubAllGlobals();
});
