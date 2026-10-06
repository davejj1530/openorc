import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Block } from "../lib/transcript";
import { TranscriptContents, WorkTranscript } from "./Transcript";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onFrame: vi.fn(), onInvalidate: vi.fn(), onReady: vi.fn() } }));
vi.mock("./ThreadImages", () => ({
  ThreadRichText: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ThreadImage: () => null,
  ThreadLink: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  isImageView: () => false,
  isImageGeneration: () => false,
}));
vi.mock("./AgentOrb", () => ({ AgentOrb: () => null }));
vi.mock("./TaskCard", () => ({ TaskCard: () => null }));
vi.mock("./QuestionCard", () => ({ QuestionCard: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("copies each thread message's original text and reports success", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const blocks: Block[] = [
    { kind: "message", id: "user", role: "user", text: "Please check this\nline.", streaming: false, at: Date.now() - 300_000, runId: "run" },
    { kind: "message", id: "assistant", role: "assistant", text: "**Done**\n\n- item", streaming: false },
  ];
  render(<TranscriptContents runId="run" blocks={blocks} groupTools={false} onFork={vi.fn()} />);
  const buttons = screen.getAllByRole("button", { name: "Copy message" });
  expect(buttons).toHaveLength(2);
  const userFooter = screen.getByRole("button", { name: "Fork thread" }).parentElement;
  expect(userFooter?.contains(buttons[0]!)).toBe(true);
  expect(userFooter?.querySelector("div[title]")?.textContent).toBeTruthy();
  fireEvent.click(buttons[0]!);
  fireEvent.click(buttons[1]!);
  await waitFor(() => expect(writeText).toHaveBeenNthCalledWith(2, "**Done**\n\n- item"));
  expect(writeText).toHaveBeenNthCalledWith(1, "Please check this\nline.");
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Message copied" })).toHaveLength(2));
});

it("reports a clipboard failure on the message control", async () => {
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  render(<TranscriptContents runId="run" blocks={[{ kind: "message", id: "reply", role: "assistant", text: "Reply", streaming: false }]} groupTools={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
  expect(await screen.findByRole("button", { name: "Could not copy message" })).toBeTruthy();
});

it("offers a fork only at the latest message, since a fork carries the whole conversation", () => {
  const onFork = vi.fn();
  const message = (id: string, role: "user" | "assistant", text: string): Block => ({ kind: "message", id, role, text, streaming: false, runId: "run" });
  render(
    <WorkTranscript
      runId="run"
      blocks={[message("first", "user", "Start"), message("one", "assistant", "Done"), message("second", "user", "Again"), message("two", "assistant", "Done again")]}
      onFork={onFork}
    />,
  );
  const fork = screen.getByRole("button", { name: "Fork thread" });
  expect(fork.closest(".journal-message")?.textContent).toContain("Again");
  fireEvent.click(fork);
  expect(onFork).toHaveBeenCalledWith();
});
