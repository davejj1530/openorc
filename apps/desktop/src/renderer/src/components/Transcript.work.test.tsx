import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEvent, ProviderUsage } from "@openorc/protocol";
import { runs } from "../lib/client";
import { type Block } from "@openorc/client";
import { core } from "../lib/rpc";
import { TeamWorkTranscript } from "./TeamWorkTranscript";
import { Transcript, WorkTranscript, groupBlocks, groupSummary, AgentPresence } from "./Transcript";
vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
vi.mock("./ThreadImages", () => ({
  ThreadRichText: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ThreadMedia: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useThreadMedia: () => ({ fileScope: { kind: "thread", id: "thread-1" }, openImage: () => {} }),
  ThreadImage: () => null,
  ThreadLink: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  isImageView: () => false,
  ImageViewRow: () => <div>Viewed image</div>,
  isImageGeneration: (b: Block) => b.kind === "activity" && b.activityKind === "image_generation",
  ImageGenerationRow: () => <div>Generated image</div>,
}));
vi.mock("./InlineDiff", () => ({ InlineDiff: ({ patch }: { patch: string }) => <pre data-testid="diff">{patch}</pre>, EditDiff: () => null }));
vi.mock("./AgentOrb", () => ({ AgentOrb: ({ state }: { state: string }) => <div data-testid="orb31" data-state={state} /> }));
vi.mock("./TaskCard", () => ({ TaskCard: ({ taskId }: { taskId: string }) => <div>Task {taskId}</div> }));
vi.mock("./QuestionCard", () => ({ QuestionCard: () => <div>Question for you</div> }));
afterEach(cleanup);
// The transcript follows its tail through a ResizeObserver, which jsdom lacks.
Object.assign(globalThis, {
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});
/** The turn's receipt row, which opens and folds its work. */
const receipt = () => document.querySelector<HTMLButtonElement>(".turn-receipt")!;
const tool: Block = { id: "read", kind: "tool", name: "read_file", input: { path: "src/source.ts" }, output: "source contents", done: false, at: 1000 };
const thought: Block = { id: "think", kind: "thinking", text: "Available reasoning summary", startedAt: 1100, endedAt: 1200 };
const reply: Block = { id: "reply", kind: "message", role: "assistant", text: "The final answer.", streaming: false };
const end: Block = { id: "end", kind: "status", boundary: "turn", durationMs: 222000, outcome: "success", text: "turn finished", tone: "ok" };

it("shows a lone startup status once without a duplicate disclosure", () => {
  const startup: Block = { id: "startup", kind: "activity", label: "Starting OpenCode", status: "success", text: "" };
  render(<WorkTranscript runId="run" blocks={[startup, { ...end, durationMs: 0, outcome: "error" }]} />);
  expect(document.querySelector(".turn-head")!.textContent).toContain("Failed after 0s");
  fireEvent.click(receipt());
  const row = screen.getByRole("button", { name: "Starting OpenCode" });
  expect(row.getAttribute("aria-expanded")).toBeNull();
  expect(row.hasAttribute("disabled")).toBe(true);
  expect(screen.getAllByText("Starting OpenCode")).toHaveLength(1);
});
it("opens a lone activity directly to its content", () => {
  const activity: Block = { id: "plan", kind: "activity", label: "Planning", status: "success", text: "The actual plan" };
  render(<WorkTranscript runId="run" blocks={[activity, end]} />);
  fireEvent.click(receipt());
  fireEvent.click(screen.getByRole("button", { name: "Planning" }));
  expect(screen.getByText("The actual plan")).toBeTruthy();
  expect(screen.getAllByText("Planning")).toHaveLength(1);
});
it("opens a lone reasoning row directly to its summary", () => {
  render(<WorkTranscript runId="run" blocks={[thought, end]} />);
  fireEvent.click(receipt());
  fireEvent.click(screen.getByRole("button", { name: "Thought for 1 second" }));
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
  fireEvent.click(receipt());
  fireEvent.click(screen.getByRole("button", { name: "Used Codegraph, used Mobbin" }));
  for (const [chip, call] of [
    ["explore", /^Codegraph: explore who calls describe/],
    ["search screens", /^Mobbin: search screens onboarding/],
    ["get design context", /^Figma: get design context/],
    ["thread list", /^OpenOrc: thread list/],
  ] as const) {
    fireEvent.click(screen.getByRole("button", { name: chip }));
    expect(screen.getByRole("button", { name: call }).getAttribute("aria-expanded")).toBe("true");
  }
  expect(groupSummary([call("task", `${own}.task_create`, { title: "Ship it" })])).toBe("Created task");
});

it("reads a described command as its description, with the command one click deeper", () => {
  const run: Block = { ...tool, id: "bash", name: "Bash", input: { command: "pnpm --filter desktop test", description: "Run the desktop tests" }, output: "48 passed", done: true };
  render(<WorkTranscript runId="run" blocks={[run, reply, end]} />);
  expect(receipt().getAttribute("aria-label")).toContain("tests passed");
  fireEvent.click(receipt());
  fireEvent.click(screen.getByRole("button", { name: "Run the desktop tests" }));
  // The command's card already reads the command and its last line, so it stays closed instead of repeating them.
  expect(screen.getByRole("button", { name: /^Ran pnpm --filter desktop test/ }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByText("48 passed")).toBeTruthy();
});
it("opens an edited file's chip to its diff, not the file", async () => {
  const input = [
    { path: "src/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-old a\n+new a" },
    { path: "src/b.ts", kind: "update", diff: "@@ -1 +1 @@\n-old b\n+new b" },
  ];
  const patch: Block = { ...tool, id: "patch", name: "apply_patch", input, output: "Success", done: true };
  render(<WorkTranscript runId="run" blocks={[patch, reply, end]} />);
  fireEvent.click(receipt());
  fireEvent.click(screen.getByRole("button", { name: "Edited 2 files" }));
  const chip = screen.getByTitle("src/a.ts");
  expect(chip.tagName).toBe("BUTTON");
  fireEvent.click(chip);
  expect(chip.getAttribute("aria-pressed")).toBe("true");
  const diff = await screen.findByTestId("diff");
  expect(diff.textContent).toContain("+new a");
  expect(diff.textContent).not.toContain("new b");
});
it("carries the live step on one line, open or folded", () => {
  const reasoning: Block = { id: "think-r", kind: "thinking", text: "**Running the desktop tests**\n\nThey cover the row.", startedAt: Date.now() - 4000, endedAt: Date.now() - 3000 };
  const running: Block = { ...tool, id: "cmd", name: "shell", input: { command: "pnpm test" }, at: Date.now() };
  render(<WorkTranscript runId="run" blocks={[reasoning, running]} live />);
  expect(screen.getByRole("button", { name: /^Running the desktop tests/ }).getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(receipt());
  expect(screen.getByRole("status").textContent).toMatch(/^Running the desktop tests/);
});
it("preserves an inspected command when it fails and a retry arrives", () => {
  const command: Block = { ...tool, name: "shell", input: { command: "pnpm test" } };
  const { rerender } = render(<WorkTranscript runId="run" blocks={[command]} live />);
  // A phase that is its one call opens straight to it.
  fireEvent.click(screen.getByRole("button", { name: /Running command pnpm test/ }));
  const failed: Block = { ...command, done: true, isError: true, status: "error", output: "7 tests failed" };
  rerender(<WorkTranscript runId="run" blocks={[failed, { ...command, id: "retry" }]} live />);
  expect(screen.getByRole("button", { name: /pnpm test.*Failed/ }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("7 tests failed")).toBeTruthy();
});
it("defaults completed work closed, preserves the final answer and reveals nested detail with keyboard-accessible controls", () => {
  render(<WorkTranscript runId="run" blocks={[{ ...tool, done: true }, thought, reply, end]} />);
  const work = receipt();
  expect(work.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByText("The final answer.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Read a file" })).toBeNull();
  fireEvent.click(work);
  fireEvent.click(screen.getByRole("button", { name: "Read a file" }));
  fireEvent.click(screen.getByRole("button", { name: "Read" }));
  fireEvent.click(screen.getByRole("button", { name: /Read src\/source.ts/ }));
  expect(screen.getByText("source contents")).toBeTruthy();
  fireEvent.click(work);
  fireEvent.click(work);
  expect(screen.getByRole("button", { name: /Read src\/source.ts/ }).getAttribute("aria-expanded")).toBe("true");
});
it("keeps pending input visible and failed tools inside collapsed work", () => {
  const attention: Block[] = [
    { kind: "approval", id: "ask", approvalId: "ask", approvalKind: "user_input", input: {} },
    { ...tool, id: "failed", name: "exec", input: { cmd: "failed-test" }, isError: true, done: true },
  ];
  render(<WorkTranscript runId="run" blocks={[{ ...tool, done: true }, ...attention, reply, end]} />);
  expect(screen.getByText("Question for you")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /failed-test.*Failed/ })).toBeNull();
  fireEvent.click(receipt());
  expect(screen.queryByRole("button", { name: /failed-test.*Failed/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Read a file, ran a command" }));
  fireEvent.click(screen.getByRole("button", { name: "Ran" }));
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
  runs.applyFrame({ runId, seq: 1, events: events.slice(0, 3) });
  const { rerender, unmount } = render(<Component runId={runId} blocks={runs.get(runId)!.blocks} live />);
  expect(screen.queryByRole("button", { name: /pnpm test.*Failed/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Running the tests" })).toBeTruthy();

  runs.applyFrame({ runId, seq: 2, events: events.slice(3) });
  rerender(<Component runId={runId} blocks={runs.get(runId)!.blocks} />);
  expect(receipt().getAttribute("aria-label")).toContain("tests passed");
  expect(receipt().getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector(".turn-head")!.textContent).toContain("6m 21s");
  expect(screen.queryByRole("button", { name: /.*Failed/ })).toBeNull();
  expect(screen.getByText("Verified all 37 tests.")).toBeTruthy();

  unmount();
  runs.reset();
  vi.mocked(core.call).mockResolvedValue({ events, fromTurn: 0, live: false });
  await runs.hydrate(runId);
  render(<Component runId={runId} blocks={runs.get(runId)!.blocks} />);
  expect(screen.queryByRole("button", { name: /.*Failed/ })).toBeNull();
  fireEvent.click(receipt());
  expect(screen.queryByRole("button", { name: /.*Failed/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Read a file, ran the tests" }));
  fireEvent.click(screen.getByRole("button", { name: "Read" }));
  fireEvent.click(screen.getByRole("button", { name: "Ran" }));
  fireEvent.click(screen.getByRole("button", { name: /cat scripts\/build-mascot-review.cjs.*Failed/ }));
  fireEvent.click(screen.getByRole("button", { name: /pnpm test.*Failed/ }));
  expect(screen.getByText("No such file or directory")).toBeTruthy();
  expect(screen.getByText("7 tests failed")).toBeTruthy();
  expect(screen.getByText("Verified all 37 tests.").closest(".work-section")).toBeNull();
});
it("preserves the orb presence independently of the work header", () => {
  const { rerender } = render(<AgentPresence working />);
  expect(screen.getByTestId("orb31").dataset.state).toBe("thinking");
  rerender(<AgentPresence working={false} />);
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
  expect(screen.getByText("Failed after 3m 42s")).toBeTruthy();
  expect(screen.getByText("Provider lost connection")).toBeTruthy();
});

it("keeps a streaming reply outside activity while retaining intermediate work and ambient privacy", () => {
  const streaming: Block = { ...reply, streaming: true };
  const { container, rerender } = render(<TeamWorkTranscript runId="run" blocks={[thought, streaming]} live showActivity={false} />);
  expect(screen.getByText("The final answer.").closest(".work-section")).toBeNull();
  rerender(<TeamWorkTranscript runId="run" blocks={[thought, streaming]} live showActivity />);
  expect(screen.getAllByText("The final answer.")).toHaveLength(1);
  expect(screen.getByText("The final answer.").closest(".work-section")).toBeNull();
  fireEvent.click(receipt());
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
  expect(document.querySelector(".turn-head")!.textContent).toBe(`Sol 2${outcome === "error" ? "Failed" : "Stopped"} after 3m 42s`);
  expect(screen.queryByRole("button")).toBeNull();
});

it("keeps quota recovery visible when work is collapsed and preserves it through hydration", async () => {
  const { useRouter } = await import("../lib/router");
  const navigate = vi.spyOn(useRouter.getState(), "navigate");
  const event: AgentEvent = { type: "activity.updated", runId: "quota", ts: 1, activityId: "limit", label: "Rate limit reached", status: "error", recovery: { kind: "usage", provider: "claude" } };
  vi.mocked(core.call).mockResolvedValueOnce({ events: [event], fromTurn: 0, live: false } as never);
  await runs.hydrate("quota");
  const run = runs.get("quota")!;
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
  expect(useLayout.getState().panelRequest).toEqual({ tab: "terminal" });
  const typed: string[] = [];
  const shell = typeAtPrompt("thread:thread-1", (command) => typed.push(command));
  shell.output("\x1b[?2004h");
  shell.dispose();
  expect(typed).toEqual(["claude auth login"]);

  fireEvent.click(receipt());
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

it("shows a manual compaction between turns as finished work, not a turn under way", () => {
  // The events core recorded on 2026-10-20 for a Claude thread's /compact, between two turns of one warm session.
  runs.reset();
  const runId = "7c17e6fe-855f-4133-816e-a3ec9a25b00e";
  const frame = (seq: number, events: AgentEvent[]) => runs.applyFrame({ runId, seq, events });
  const heads = () => [...document.querySelectorAll(".turn-head")].map((head) => head.getAttribute("data-state"));
  frame(1, [
    { type: "session.started", runId, ts: 1792467848859, agent: "claude", externalSessionId: "dd1b0fd3-115e-4d6d-8274-0001c648144c", model: "claude-opus-5-5" },
    { type: "message.completed", runId, ts: 1792474970926, messageId: "user-10cec7e1-811d-4cea-a4e4-e2c9361e3470", role: "user", text: "Looking great, one more thing." },
    { type: "turn.started", runId, ts: 1792474971082, turnId: "e2ae868b-0373-4c9c-b720-28b0b1d832bf" },
    { type: "message.completed", runId, ts: 1792476111112, messageId: "msg_011CgCyqNGB1TcsfJ7vF4fkQ", role: "assistant", text: "Both are built, uncommitted." },
    { type: "turn.completed", runId, ts: 1792476111125, turnId: "766599d6-01ab-40ef-9b09-d267f07f42a1", status: "success", resultText: "Both are built, uncommitted.", durationMs: 1140194 },
    { type: "activity.updated", runId, ts: 1792476274142, activityId: "compaction-1", label: "Compacting context", status: "running", detail: { mode: "manual" } },
  ]);
  // Core reports the thread busy while it compacts: the head and the live row say so.
  const { rerender } = render(<Transcript run={runs.get(runId)!} working />);
  expect(heads()).toEqual(["done", "working"]);
  expect(document.querySelector(".tool-row-live")).toBeTruthy();
  expect(document.body.textContent).toContain("Compacting context");
  frame(2, [
    {
      type: "activity.updated",
      runId,
      ts: 1792476346983,
      activityId: "compaction-1",
      label: "Compacting context",
      status: "success",
      text: "851,927 tokens folded into 22,712.",
      detail: { mode: "manual" },
    },
    {
      type: "message.completed",
      runId,
      ts: 1792476346986,
      messageId: "compact-2ca37c99-4cf9-466a-9fc6-96ced4eb09bb",
      role: "system",
      text: "Context compacted. The agent continues from a summary of the conversation so far.",
    },
  ]);
  // The compaction ended and core reports the thread idle; the session stays open for the next message.
  rerender(<Transcript run={runs.get(runId)!} working={false} />);
  expect(runs.get(runId)!.live).toBe(true);
  expect(heads()).toEqual(["done", "done"]);
  expect(document.querySelector(".tool-row-live")).toBeNull();
  expect(document.querySelector(".work-now")).toBeNull();
  expect(receipt().textContent).toMatch(/1 step/);
  expect(document.body.textContent).toContain("Context compacted.");
  frame(3, [
    { type: "message.completed", runId, ts: 1792476572518, messageId: "user-f12095cd-e7e7-4b56-a774-b87e6c84964e", role: "user", text: "Thanks, now update the website." },
    { type: "turn.started", runId, ts: 1792476572650, turnId: "a1288048-7abe-43a4-8741-11e5680ce322" },
  ]);
  // The next prompt opens a turn before core's busy flag reaches the view.
  rerender(<Transcript run={runs.get(runId)!} working={false} />);
  expect(heads()).toEqual(["done", "done", "working"]);
});
