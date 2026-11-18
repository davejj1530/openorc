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

it("opens a path the agent writes as inline code in the Files tool, at its line, and leaves other code alone", async () => {
  const openFile = vi.spyOn(useLayout.getState(), "openFile").mockImplementation(() => undefined);
  const reply = "I changed `src/cart.ts:42` and `useCart.getState()`.\n\n```\nsrc/never.ts\n```";
  render(
    <ThreadMedia scopeKey="here" basePath="/repo" fileScope={{ kind: "thread", id: "t1" }}>
      <ThreadRichText codePaths>{reply}</ThreadRichText>
    </ThreadMedia>,
  );
  const path = await screen.findByText("src/cart.ts:42");
  expect(path.tagName).toBe("CODE");
  fireEvent.click(path);
  expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ path: "/repo/src/cart.ts", line: 42, scope: { kind: "thread", id: "t1" } }));
  expect(screen.getByText("useCart.getState()").closest("a")).toBeNull();
  expect(screen.getByText("src/never.ts").closest("a")).toBeNull();
  openFile.mockRestore();
});

it("leaves a path in inline code as code where the conversation's files are elsewhere", async () => {
  render(
    <ThreadMedia scopeKey="cloud" fileLinks="cite">
      <ThreadRichText codePaths>{"See `src/cart.ts`."}</ThreadRichText>
    </ThreadMedia>,
  );
  expect((await screen.findByText("src/cart.ts")).closest("a, [title]")).toBeNull();
});

it("leaves a document's inline code as code, since its paths may be from another folder than its own", async () => {
  render(
    <ThreadMedia scopeKey="docs/guide.md" basePath="/repo/docs" fileScope={{ kind: "thread", id: "t1" }}>
      <ThreadRichText>{"Colors live in `apps/desktop/src/theme.ts`."}</ThreadRichText>
    </ThreadMedia>,
  );
  expect((await screen.findByText("apps/desktop/src/theme.ts")).closest("a")).toBeNull();
});

it("keeps a path in code that is already a link pointing where the link does", async () => {
  const openFile = vi.spyOn(useLayout.getState(), "openFile").mockImplementation(() => undefined);
  render(
    <ThreadMedia scopeKey="here" basePath="/repo" fileScope={{ kind: "thread", id: "t1" }}>
      <ThreadRichText codePaths>{"See [`src/cart.ts`](src/other.ts:3)."}</ThreadRichText>
    </ThreadMedia>,
  );
  fireEvent.click(await screen.findByText("src/cart.ts"));
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(openFile).toHaveBeenCalledTimes(1);
  expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ path: "/repo/src/other.ts", line: 3 }));
  openFile.mockRestore();
});
