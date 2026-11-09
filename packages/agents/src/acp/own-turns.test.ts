import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentEvent, RunStatus } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnTurnWatcher } from "./own-turns.js";
import type { OwnTurns, SessionEntry } from "./profile.js";

const finished = (name: string, output: string): AgentEvent => ({
  type: "tool.completed",
  runId: "r",
  ts: 1,
  toolCallId: "t",
  name,
  output,
  isError: false,
  status: "success",
  input: { command: "make build" },
});
const words = (id: string, text: string): SessionEntry => ({ id, kind: "assistant", updates: [{ sessionUpdate: "agent_message_chunk", messageId: id, content: { type: "text", text } }] });

function setup() {
  let entries: SessionEntry[] = [];
  const source: OwnTurns = {
    read: vi.fn(async () => entries),
    leftRunning: ({ id, name }) => (name === "run_command" ? { id, description: "make build" } : null),
    startedJob: ({ output }) => (typeof output === "string" && output.startsWith("bg:") ? { id: output.slice(3), description: "make build" } : null),
  };
  const events: AgentEvent[] = [];
  const fed: SessionUpdate[] = [];
  const closed: RunStatus[] = [];
  let prompting = false;
  let answering = false;
  const watcher = new OwnTurnWatcher(source, {
    runId: "r",
    run: async () => "",
    env: {},
    session: () => "ses_1",
    emit: (event) => events.push(event),
    now: () => Date.now(),
    prompting: () => prompting,
    answering: () => answering,
    open: () => {
      answering = true;
      events.push({ type: "turn.started", runId: "r", ts: 1, turnId: "own" });
    },
    feed: (update) => fed.push(update),
    close: (status) => {
      answering = false;
      closed.push(status);
    },
  });
  return {
    watcher,
    source,
    events,
    fed,
    closed,
    set: (next: SessionEntry[]) => (entries = next),
    prompt: (on: boolean) => (prompting = on),
  };
}

describe("OwnTurnWatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lists a job a tool call left running until its report, and replays the turn the report starts", async () => {
    const s = setup();
    s.watcher.saw({ sessionUpdate: "agent_message_chunk", messageId: "msg_1", content: { type: "text", text: "Started." } });
    s.watcher.observe(finished("shell", "bg:sh_1"));
    expect(s.events.at(-1)).toMatchObject({ type: "background.updated", running: 0, commands: [{ id: "sh_1", description: "make build" }] });
    s.watcher.promptEnded();

    s.set([words("msg_1", "Started."), { id: "msg_2", kind: "idle", outcome: "success" }]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.fed).toEqual([]);

    s.set([
      words("msg_1", "Started."),
      { id: "msg_2", kind: "idle", outcome: "success" },
      { id: "msg_3", kind: "other", job: { id: "sh_1", state: "completed", exit: 0 } },
      words("msg_4", "The build"),
    ]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    expect(s.events).toContainEqual(expect.objectContaining({ type: "message.completed", role: "system", text: "Background command finished: make build" }));
    expect(s.events.at(-1)).toMatchObject({ type: "background.updated", commands: [] });
    expect(s.fed).toEqual([{ sessionUpdate: "agent_message_chunk", messageId: "msg_4", content: { type: "text", text: "The build" } }]);

    s.set([
      words("msg_1", "Started."),
      { id: "msg_2", kind: "idle", outcome: "success" },
      { id: "msg_3", kind: "other", job: { id: "sh_1", state: "completed", exit: 0 } },
      words("msg_4", "The build passed."),
      { id: "msg_5", kind: "idle", outcome: "success" },
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.fed.at(-1)).toEqual({ sessionUpdate: "agent_message_chunk", messageId: "msg_4", content: { type: "text", text: " passed." } });
    expect(s.closed).toEqual(["success"]);
    expect(s.watcher.active).toBe(false);
  });

  it("reads nothing while a prompt of OpenOrc's is in flight, and drops a job whose report that turn carried", async () => {
    const s = setup();
    s.watcher.observe(finished("shell", "bg:sh_1"));
    s.prompt(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.source.read).not.toHaveBeenCalled();
    s.prompt(false);
    s.watcher.saw({ sessionUpdate: "agent_message_chunk", messageId: "msg_3", content: { type: "text", text: "Done." } });
    s.watcher.promptEnded();
    s.set([
      { id: "msg_1", kind: "user", text: "Wait for it" },
      { id: "msg_2", kind: "other", job: { id: "sh_1", state: "completed" } },
      words("msg_3", "Done."),
      { id: "msg_4", kind: "idle", outcome: "success" },
    ]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.fed).toEqual([]);
    expect(s.events.filter((event) => event.type === "turn.started")).toHaveLength(0);
    expect(s.events.at(-1)).toMatchObject({ type: "background.updated", commands: [] });
    expect(s.watcher.active).toBe(false);
  });

  it("takes a call still open at the turn's end for its job, finds the turn's end by its words, and finishes the call with the report", async () => {
    const s = setup();
    s.watcher.observe({ type: "tool.started", runId: "r", ts: 1, toolCallId: "call_1", name: "run_command", input: { CommandLine: "make build" }, parentToolCallId: null });
    s.watcher.promptEnded("Started the build.");
    expect(s.events.at(-1)).toMatchObject({ type: "background.updated", commands: [{ id: "call_1", description: "make build" }] });
    const prompt = [words("step-1", "Earlier."), { id: "step-1:end", kind: "idle", outcome: "success" } as const, words("step-3", "Started the build.")];
    // The prompt's last words are not written as a finished turn yet: nothing is taken for the agent's own.
    s.set(prompt);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.fed).toEqual([]);
    s.set([
      ...prompt,
      { id: "step-3:end", kind: "idle", outcome: "success" },
      { id: "step-4", kind: "other", job: { id: "ses/task-2", state: "completed", exit: 0, output: "built", command: "make build" } },
      words("step-5", "It built."),
      { id: "step-5:end", kind: "idle", outcome: "success" },
    ]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.fed).toEqual([
      { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed", rawOutput: { output: "built" } },
      { sessionUpdate: "agent_message_chunk", messageId: "step-5", content: { type: "text", text: "It built." } },
    ]);
    expect(s.events).toContainEqual(expect.objectContaining({ type: "message.completed", role: "system", text: "Background command finished: make build" }));
    expect(s.closed).toEqual(["success"]);
    expect(s.watcher.active).toBe(false);
  });

  it("ignores tool calls that leave nothing running and stops listing jobs once closed", () => {
    const s = setup();
    s.watcher.observe(finished("shell", "done"));
    expect(s.events).toEqual([]);
    s.watcher.observe(finished("shell", "bg:sh_9"));
    s.watcher.close();
    expect(s.events.at(-1)).toMatchObject({ type: "background.updated", commands: [] });
    expect(s.watcher.active).toBe(false);
  });
});
