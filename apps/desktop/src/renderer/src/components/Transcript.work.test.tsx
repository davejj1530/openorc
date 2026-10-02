import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEvent, ProviderUsage } from "@openorc/protocol";
import { applyFrame, getRun, hydrate, resetTranscripts, type Block } from "../lib/transcript";
import { core } from "../lib/rpc";
import { TeamWorkTranscript } from "./TeamWorkTranscript";
import { WorkTranscript, groupBlocks, groupSummary, AgentPresence } from "./Transcript";
vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onFrame: vi.fn(), onInvalidate: vi.fn(), onReady: vi.fn() } }));
vi.mock("./ThreadImages", () => ({
  ThreadRichText: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ThreadMedia: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useThreadMedia: () => ({ fileScope: { kind: "thread", id: "thread-1" }, openImage: () => {} }),
  ThreadImage: () => null,
  isImageView: () => false,
  ImageViewRow: () => <div>Viewed image</div>,
  isImageGeneration: (b: Block) => b.kind === "activity" && b.activityKind === "image_generation",
  ImageGenerationRow: () => <div>Generated image</div>,
}));
vi.mock("./AgentOrb", () => ({ AgentOrb: ({ state }: { state: string }) => <div data-testid="orb31" data-state={state} /> }));
vi.mock("./TaskCard", () => ({ TaskCard: ({ taskId }: { taskId: string }) => <div>Task {taskId}</div> }));
vi.mock("./QuestionCard", () => ({ QuestionCard: () => <div>Question for you</div> }));
afterEach(cleanup);
const tool: Block = { id: "read", kind: "tool", name: "read_file", input: { path: "source.ts" }, output: "source contents", done: false, at: 1000 };
const thought: Block = { id: "think", kind: "thinking", text: "Available reasoning summary", startedAt: 1100, endedAt: 1200 };
const reply: Block = { id: "reply", kind: "message", role: "assistant", text: "The final answer.", streaming: false };
const end: Block = { id: "end", kind: "status", boundary: "turn", durationMs: 222000, outcome: "success", text: "turn finished", tone: "ok" };

it("shows a lone startup status once without a duplicate disclosure", () => {
  const startup: Block = { id: "startup", kind: "activity", label: "Starting OpenCode", status: "success", text: "" };
  render(<WorkTranscript runId="run" blocks={[startup, { ...end, durationMs: 0, outcome: "error" }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Failed for 0s" }));
  const row = screen.getByRole("button", { name: "Starting OpenCode" });
  expect(row.getAttribute("aria-expanded")).toBeNull();
  expect(row.hasAttribute("disabled")).toBe(true);
  expect(screen.getAllByText("Starting OpenCode")).toHaveLength(1);
});
it("opens a lone activity directly to its content", () => {
  const activity: Block = { id: "plan", kind: "activity", label: "Planning", status: "success", text: "The actual plan" };
  render(<WorkTranscript runId="run" blocks={[activity, end]} />);
  fireEvent.click(screen.getByRole("button", { name: "Worked for 3m 42s" }));
  fireEvent.click(screen.getByRole("button", { name: "Planning" }));
  expect(screen.getByText("The actual plan")).toBeTruthy();
  expect(screen.getAllByText("Planning")).toHaveLength(1);
});
it("opens a lone reasoning row directly to its summary", () => {
  render(<WorkTranscript runId="run" blocks={[thought, end]} />);
  fireEvent.click(screen.getByRole("button", { name: "Worked for 3m 42s" }));
  fireEvent.click(screen.getByRole("button", { name: "Thought for 1s" }));
  expect(screen.getByText("Available reasoning summary")).toBeTruthy();
});

it("folds across thinking pauses into a single descriptive summary", () => {
  const blocks: Block[] = [{ ...tool, done: true }, thought, { ...tool, id: "graph", name: "mcp__codegraph__codegraph_explore", done: true }];
  expect(groupBlocks(blocks)).toHaveLength(1);
  expect(groupSummary(blocks)).toBe("Read a file, used Codegraph");
});
it("names MCP tool calls by server and tool in each provider's naming", () => {
  const call = (id: string, name: string, input: unknown = {}): Block => ({ ...tool, id, name, input, done: true });
  const own = `openorc_${"a".repeat(32)}`;
  const blocks: Block[] = [
    call("claude", "mcp__codegraph__codegraph_explore", { query: "who calls describe" }),
    call("codex", "mobbin.search_screens", { query: "onboarding" }),
    call("connector", "mcp__claude_ai_Figma__get_design_context"),
    call("opencode", `${own}_thread_list`),
    reply,
    end,
  ];
  render(<WorkTranscript runId="run" blocks={blocks} />);
  fireEvent.click(screen.getByRole("button", { name: "Worked for 3m 42s" }));
  fireEvent.click(screen.getByRole("button", { name: "Used Codegraph, used Mobbin, used Figma, used OpenOrc" }));
  for (const label of [/^Codegraph: explore who calls describe/, /^Mobbin: search screens onboarding/, /^Figma: get design context/, /^OpenOrc: thread list/])
    expect(screen.getByRole("button", { name: label })).toBeTruthy();
  expect(groupSummary([call("task", `${own}.task_create`, { title: "Ship it" })])).toBe("Created task");
});

it("preserves an inspected command when it fails and a retry arrives", () => {
  const command: Block = { ...tool, name: "shell", input: { command: "pnpm test" } };
  const { rerender } = render(<WorkTranscript runId="run" blocks={[command]} live />);
  fireEvent.click(screen.getByRole("button", { name: "Running command" }));
  fireEvent.click(screen.getByRole("button", { name: /Running command pnpm test/ }));
  const failed: Block = { ...command, done: true, isError: true, status: "error", output: "7 tests failed" };
  rerender(<WorkTranscript runId="run" blocks={[failed, { ...command, id: "retry" }]} live />);
  expect(screen.getByRole("button", { name: /pnpm test.*Failed/ }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("7 tests failed")).toBeTruthy();
});
it("defaults completed work closed, preserves the final answer and reveals nested detail with keyboard-accessible controls", () => {
  render(<WorkTranscript runId="run" blocks={[{ ...tool, done: true }, thought, reply, end]} />);
  const work = screen.getByRole("button", { name: "Worked for 3m 42s" });
  expect(work.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByText("The final answer.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Read a file" })).toBeNull();
  fireEvent.click(work);
  fireEvent.click(screen.getByRole("button", { name: "Read a file" }));
  fireEvent.click(screen.getByRole("button", { name: /Read source.ts/ }));
  expect(screen.getByText("source contents")).toBeTruthy();
  fireEvent.click(work);
  fireEvent.click(work);
  expect(screen.getByRole("button", { name: /Read source.ts/ }).getAttribute("aria-expanded")).toBe("true");
});
it("keeps pending input visible and failed tools inside collapsed work", () => {
  const attention: Block[] = [
    { kind: "approval", id: "ask", approvalId: "ask", approvalKind: "user_input", input: {} },
    { ...tool, id: "failed", name: "exec", input: { cmd: "failed-test" }, isError: true, done: true },
  ];
  render(<WorkTranscript runId="run" blocks={[{ ...tool, done: true }, ...attention, reply, end]} />);
  expect(screen.getByText("Question for you")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /failed-test.*Failed/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Worked for 3m 42s" }));
  expect(screen.queryByRole("button", { name: /failed-test.*Failed/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Read a file, ran a command" }));
  expect(screen.getByRole("button", { name: /failed-test.*Failed/ })).toBeTruthy();
});

it.each([["individual", WorkTranscript]] as const)("keeps failed attempts in %s work through retry, completion, and history reload", async (kind, Component) => {
  const runId = `recovered-${kind}`;
  const base = { runId, ts: 1000 };
  const events: AgentEvent[] = [
    {
      ...base,
      type: "tool.completed",
      toolCallId: "missing-file",
      name: "shell",
      input: { command: "cat scripts/build-mascot-review.cjs" },
      output: "No such file or directory",
      isError: true,
      status: "error",
    },
    { ...base, type: "tool.completed", toolCallId: "failed-test", name: "shell", input: { command: "pnpm test" }, output: "7 tests failed", isError: true, status: "error" },
    { ...base, type: "tool.started", toolCallId: "retry", name: "shell", input: { command: "pnpm test" }, parentToolCallId: null },
    { ...base, type: "tool.completed", toolCallId: "retry", name: "shell", output: "37 tests passed", isError: false, status: "success" },
    { ...base, type: "message.completed", messageId: "final", role: "assistant", text: "Verified all 37 tests." },
    { ...base, type: "turn.completed", turnId: "turn", status: "success", durationMs: 381000 },
  ];
  applyFrame({ runId, seq: 1, events: events.slice(0, 3) });
  const { rerender, unmount } = render(<Component runId={runId} blocks={getRun(runId)!.blocks} live />);
  expect(screen.queryByRole("button", { name: /pnpm test.*Failed/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Ran 3 commands" })).toBeTruthy();

  applyFrame({ runId, seq: 2, events: events.slice(3) });
  rerender(<Component runId={runId} blocks={getRun(runId)!.blocks} />);
  expect(screen.getByRole("button", { name: "Worked for 6m 21s" }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: /.*Failed/ })).toBeNull();
  expect(screen.getByText("Verified all 37 tests.")).toBeTruthy();

  unmount();
  resetTranscripts();
  vi.mocked(core.call).mockResolvedValue({ events, fromTurn: 0, live: false });
  await hydrate(runId);
  render(<Component runId={runId} blocks={getRun(runId)!.blocks} />);
  expect(screen.queryByRole("button", { name: /.*Failed/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Worked for 6m 21s" }));
  expect(screen.queryByRole("button", { name: /.*Failed/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Ran 3 commands" }));
  fireEvent.click(screen.getByRole("button", { name: /cat scripts\/build-mascot-review.cjs.*Failed/ }));
  fireEvent.click(screen.getByRole("button", { name: /pnpm test.*Failed/ }));
  expect(screen.getByText("No such file or directory")).toBeTruthy();
  expect(screen.getByText("7 tests failed")).toBeTruthy();
  expect(screen.getByText("Verified all 37 tests.").closest(".work-section")).toBeNull();
});
it("preserves the orb presence independently of the work header", () => {
  const { rerender } = render(<AgentPresence working since={1000} showElapsed={false} />);
  expect(screen.getByTestId("orb31").dataset.state).toBe("thinking");
  rerender(<AgentPresence working={false} since={1000} showElapsed={false} />);
  expect(screen.getByTestId("orb31").dataset.state).toBe("idle");
});

it.each([false])("keeps a genuine turn failure visible with showActivity=%s", (showActivity) => {
  render(
    <WorkTranscript
      runId="run"
      showActivity={showActivity}
      blocks={[
        { ...tool, done: true, isError: true },
        { id: "provider-error", kind: "status", text: "Provider lost connection", tone: "bad" },
        { ...end, outcome: "error", tone: "bad" },
      ]}
    />,
  );
  expect(screen.getByText("Failed for 3m 42s")).toBeTruthy();
  expect(screen.getByText("Provider lost connection")).toBeTruthy();
});

it("keeps a streaming reply outside activity while retaining intermediate work and ambient privacy", () => {
  const streaming: Block = { ...reply, streaming: true };
  const { container, rerender } = render(<TeamWorkTranscript runId="run" blocks={[thought, streaming]} live showActivity={false} />);
  expect(screen.getByText("The final answer.").closest(".work-section")).toBeNull();
  rerender(<TeamWorkTranscript runId="run" blocks={[thought, streaming]} live showActivity />);
  expect(screen.getAllByText("The final answer.")).toHaveLength(1);
  expect(screen.getByText("The final answer.").closest(".work-section")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Working/ }));
  expect(screen.getByText("The final answer.").closest("[hidden]")).toBeNull();

  // A subsequent tool reveals that the previous text was intermediate commentary.
  rerender(<TeamWorkTranscript runId="run" blocks={[thought, reply, tool]} live showActivity={false} />);
  expect(screen.queryByText("The final answer.")).toBeNull();
  const answer: Block = { ...streaming, id: "answer", text: "The result is ready." };
  rerender(<TeamWorkTranscript runId="run" blocks={[thought, reply, { ...tool, done: true }, answer]} live showActivity={false} />);
  expect(screen.getByText("The result is ready.")).toBeTruthy();
  expect(screen.queryByText("The final answer.")).toBeNull();
  rerender(<TeamWorkTranscript runId="run" blocks={[thought, streaming]} ambient live showActivity={false} />);
  expect(container.childElementCount).toBe(0);
});

it.each(["error", "cancelled"] as const)("quiet mode retains a %s turn status without an activity control", (outcome) => {
  render(<WorkTranscript runId="run" blocks={[{ ...end, outcome }]} author="Sol 2" showActivity={false} />);
  expect(screen.getByRole("status").textContent).toBe(`Sol 2 · ${outcome === "error" ? "Failed" : "Stopped"} for 3m 42s`);
  expect(screen.queryByRole("button")).toBeNull();
});

it("keeps quota recovery visible when work is collapsed and preserves it through hydration", async () => {
  const { useRouter } = await import("../lib/router");
  const navigate = vi.spyOn(useRouter.getState(), "navigate");
  const event: AgentEvent = { type: "activity.updated", runId: "quota", ts: 1, activityId: "limit", label: "Rate limit reached", status: "error", recovery: { kind: "usage", provider: "claude" } };
  vi.mocked(core.call).mockResolvedValueOnce({ events: [event], fromTurn: 0, live: false } as never);
  await hydrate("quota");
  const run = getRun("quota")!;
  expect(run.blocks[0]).toMatchObject({ recovery: { kind: "usage", provider: "claude" } });
  render(<WorkTranscript runId="quota" blocks={[...run.blocks, { ...end, outcome: "error" }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage usage" }));
  expect(navigate).toHaveBeenCalledWith({ view: "settings", section: "usage", provider: "claude" });
  navigate.mockRestore();
});

it("signs a signed-out Claude back in from the thread's Terminal, under the folded work and on its row", async () => {
  const { useLayout } = await import("../lib/layout");
  const { typeAtPrompt } = await import("../lib/terminal-requests");
  const signedOut: Block = { id: "sign-in", kind: "activity", label: "Claude is signed out", status: "error", text: "", recovery: { kind: "sign_in", provider: "claude" } };
  render(<WorkTranscript runId="run" blocks={[signedOut, { ...end, outcome: "error" }]} />);
  const signIn = screen.getByRole("button", { name: "Sign in" });
  expect(signIn.parentElement!.textContent).toBe("Claude is signed out. Sign in");
  fireEvent.click(signIn);
  expect(useLayout.getState()).toMatchObject({ panelOpen: true, panelTab: "terminal", panelThreadId: "thread-1" });
  expect(useLayout.getState().panelTools["thread:thread-1"]).toEqual(["terminal"]);
  const typed: string[] = [];
  const shell = typeAtPrompt("thread:thread-1", (command) => typed.push(command));
  shell.output("\x1b[?2004h");
  shell.dispose();
  expect(typed).toEqual(["claude auth login"]);

  fireEvent.click(screen.getByRole("button", { name: "Failed for 3m 42s" }));
  expect(screen.getByRole("button", { name: "Sign in" }).parentElement!.textContent).toBe("Sign in");
});

const codexUsage: ProviderUsage = {
  provider: "codex",
  context: "ChatGPT · pro · fixture@example.test",
  status: "available",
  source: "Fixture",
  checkedAt: 1,
  refreshedAt: 1,
  message: null,
  windows: [],
  credits: [],
  accountUrl: "https://example.test/usage",
  localRuns: 0,
  resets: {
    availableCount: 2,
    credits: [{ id: "credit", title: "Full reset", description: "Restore eligible fixture windows", expiresAt: null }],
    redemption: "available",
    confirmationToken: "snapshot",
  },
};
const codexLimit: Block = { id: "limit", kind: "activity", label: "Rate limit reached", status: "error", text: "", recovery: { kind: "usage", provider: "codex" } };
function renderWithQueries(content: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{content}</QueryClientProvider>);
}

it("offers an available Codex reset where the limit surfaced and uses it only after confirmation", async () => {
  vi.mocked(core.call).mockImplementation((async (method: string) =>
    method === "providers.usage" ? codexUsage : { outcome: "reset", message: "Reset used.", usage: { ...codexUsage, resets: { ...codexUsage.resets!, availableCount: 1 } } }) as never);
  renderWithQueries(<WorkTranscript runId="run" blocks={[codexLimit, { ...end, outcome: "error" }]} />);
  const use = await screen.findByRole("button", { name: "Use reset" });
  expect(use.parentElement!.textContent).toBe("Usage limit reached. Use reset (2 available) · Manage usage");
  await waitFor(() => expect(use.hasAttribute("disabled")).toBe(false));
  fireEvent.click(use);
  expect(screen.getByRole("dialog").textContent).toContain("Restore eligible fixture windows");
  expect(vi.mocked(core.call).mock.calls.some(([method]) => method === "providers.codex.reset")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Confirm reset" }));
  await screen.findByText("Reset used. Send a message to continue.");
  expect(vi.mocked(core.call).mock.calls.find(([method]) => method === "providers.codex.reset")![1]).toMatchObject({ creditId: "credit", confirmationToken: "snapshot" });
  expect(screen.queryByRole("button", { name: "Use reset" })).toBeNull();
});
