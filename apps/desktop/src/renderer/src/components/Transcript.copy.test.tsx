import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Block } from "@openorc/client";
import { TranscriptContents, WorkTranscript } from "./Transcript";
import { AsksDocked } from "./ask-answer";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
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

it("keeps Copy visible on the last drawn turn when a later ask lives only in the dock", () => {
  const styles = readFileSync("src/renderer/src/styles/conversation.css", "utf8");
  const reply: Block = { kind: "message", id: "reply", role: "assistant", text: "The report is ready.", streaming: false };
  const end: Block = { kind: "status", id: "end", boundary: "turn", outcome: "success", text: "turn finished", tone: "ok" };
  const ask: Block = { kind: "approval", id: "ask", approvalId: "ask", approvalKind: "user_input", input: { questions: [{ question: "Which report?", options: [] }] } };
  const draw = (blocks: Block[]) => (
    <>
      <style>{styles}</style>
      <AsksDocked.Provider value>
        <WorkTranscript runId="run" blocks={blocks} author="Assistant" />
      </AsksDocked.Provider>
    </>
  );
  const { container, rerender } = render(draw([reply, end, ask]));
  expect(container.querySelectorAll(".work-turn")).toHaveLength(1);
  expect(getComputedStyle(screen.getByRole("button", { name: "Copy message" })).opacity).toBe("1");
  rerender(draw([reply, ask, end]));
  expect(getComputedStyle(screen.getByRole("button", { name: "Copy message" })).opacity).toBe("1");
  rerender(draw([reply, end, { kind: "message", id: "next", role: "user", text: "Check the next report.", streaming: false }]));
  const previous = container.querySelector<HTMLButtonElement>(".turn-actions .message-action")!;
  expect(getComputedStyle(previous).opacity).toBe("0");
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
  expect(userFooter?.querySelector("div[data-tip]")?.textContent).toBeTruthy();
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
  expect(fork.closest(".turn-actions")).toBeTruthy();
  expect(fork.closest("[data-turn]")?.textContent).toContain("Again");
  expect(fork.closest("[data-turn]")?.textContent).toContain("Done again");
  fireEvent.click(fork);
  expect(onFork).toHaveBeenCalledWith();
});

it("offers Allow for this run only where something keeps allowing it", () => {
  const approval = (id: string, onceOnly?: boolean): Block => ({ kind: "approval", id, approvalId: id, approvalKind: "tool", toolName: "browser", input: {}, ...(onceOnly ? { onceOnly } : {}) });
  const { unmount } = render(<TranscriptContents runId="run" blocks={[approval("click")]} />);
  expect(screen.getByRole("button", { name: "Allow for this run" })).toBeTruthy();
  unmount();
  render(<TranscriptContents runId="run" blocks={[approval("password", true)]} />);
  expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Allow for this run" })).toBeNull();
});
