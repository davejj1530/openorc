import { describe, expect, it } from "vitest";
import type { RpcMethod } from "@openorc/protocol";
import { composerActions, planSubmit, sendMessage, type SubmitCalls, type SubmitInput, type SubmitRequest } from "./conversation-submit.js";

const codex = { agent: "codex" as const, model: "gpt-5", effort: null };
const warm = { id: "A", agent: "codex" as const, mode: "act" as const, permissionMode: "trusted" as const };
const base: SubmitInput = {
  target: { kind: "thread", threadId: "thread" },
  working: false,
  live: false,
  activeRun: undefined,
  agentsUsed: [],
  choice: codex,
  mode: "act",
  permission: "trusted",
  permissionReady: true,
  compacting: false,
  now: false,
};

describe("planSubmit", () => {
  it.each([
    { name: "starts the first process fresh", input: {}, plan: { kind: "start", choice: codex, resume: false } },
    { name: "resumes the agent's earlier session", input: { agentsUsed: ["codex"], activeRun: warm }, plan: { kind: "start", choice: codex, resume: true } },
    { name: "continues on a warm process with the same settings", input: { live: true, activeRun: warm, agentsUsed: ["codex"] }, plan: { kind: "continue", runId: "A" } },
    { name: "starts again when the mode changed", input: { live: true, activeRun: { ...warm, mode: "plan" }, agentsUsed: ["codex"] }, plan: { kind: "start", choice: codex, resume: true } },
    { name: "starts again for another agent", input: { live: true, activeRun: { ...warm, agent: "claude" }, agentsUsed: ["claude"] }, plan: { kind: "start", choice: codex, resume: false } },
    { name: "steers a turn that can take it", input: { working: true, live: true, activeRun: warm, now: true }, plan: { kind: "steer", runId: "A" } },
    { name: "queues by default", input: { working: true, live: true, activeRun: warm }, plan: { kind: "queue", threadId: "thread" } },
    {
      name: "queues for an agent that reads between turns",
      input: { working: true, live: true, activeRun: { ...warm, agent: "opencode" }, choice: { ...codex, agent: "opencode" }, now: true },
      plan: { kind: "queue", threadId: "thread" },
    },
    { name: "queues while compacting", input: { working: true, live: true, activeRun: warm, compacting: true, now: true }, plan: { kind: "queue", threadId: "thread" } },
    { name: "never queues a task, which has no thread", input: { target: { kind: "task", taskId: "task" }, working: true, live: true, activeRun: warm }, plan: { kind: "continue", runId: "A" } },
    { name: "waits for saved permissions before starting", input: { permissionReady: false }, plan: { kind: "blocked", reason: "Wait for your saved permissions to load." } },
    { name: "needs a model", input: { choice: null }, plan: { kind: "blocked", reason: "Choose a model first." } },
    { name: "restarts fresh even beside a warm process", input: { restart: true, live: true, activeRun: warm, agentsUsed: ["codex"] }, plan: { kind: "start", choice: codex, resume: false } },
    { name: "restarts only once permissions are known", input: { restart: true, permissionReady: false, choice: null }, plan: { kind: "blocked", reason: "Wait for your saved permissions to load." } },
  ] as Array<{ name: string; input: Partial<SubmitInput>; plan: unknown }>)("$name", ({ input, plan }) => {
    expect(planSubmit({ ...base, ...input })).toEqual(plan);
  });
});

describe("composerActions", () => {
  const idle = { queueing: false, liveByDefault: false, steerable: false, canStop: false, hasDraft: true };
  it.each([
    { name: "sends when nothing runs", input: idle, actions: { primary: "send", sendNow: false, queue: false, stop: false, sendsNow: false } },
    {
      name: "stops in the send position with nothing to send",
      input: { ...idle, canStop: true, hasDraft: false },
      actions: { primary: "stop", sendNow: false, queue: false, stop: false, sendsNow: false },
    },
    {
      name: "queues mid-turn and offers Send now when the turn can take it",
      input: { ...idle, queueing: true, steerable: true, canStop: true },
      actions: { primary: "queue", sendNow: true, queue: false, stop: true, sendsNow: false },
    },
    { name: "queues mid-turn without Send now when it cannot", input: { ...idle, queueing: true }, actions: { primary: "queue", sendNow: false, queue: false, stop: false, sendsNow: false } },
    {
      name: "sends into the turn when that is the default, with Queue beside",
      input: { ...idle, queueing: true, liveByDefault: true },
      actions: { primary: "send", sendNow: false, queue: true, stop: false, sendsNow: true },
    },
  ])("$name", ({ input, actions }) => {
    expect(composerActions(input)).toEqual(actions);
  });
});

describe("sendMessage", () => {
  function submitter() {
    const calls: Array<[RpcMethod, unknown]> = [];
    const call = (method: RpcMethod) => ({ mutateAsync: async (params: unknown) => void calls.push([method, params]) });
    const mutations = { start: call("runs.start"), send: call("runs.send"), queue: call("threads.queue") } as SubmitCalls;
    return { calls, submit: (request: SubmitRequest, message: { text: string; attachments: string[] }) => sendMessage(mutations, () => "key", request, message) };
  }

  it("makes no call until every chosen setting is saved, then exactly the planned one", async () => {
    const { calls, submit } = submitter();
    let saved: () => void = () => undefined;
    const sending = submit({ ...base, working: true, live: true, activeRun: warm, waitForSave: () => new Promise<void>((resolve) => (saved = resolve)) }, { text: "", attachments: ["/shot.png"] });
    await Promise.resolve();
    expect(calls).toEqual([]);
    saved();
    await sending;
    expect(calls).toEqual([["threads.queue", { id: "thread", text: "See the attached image.", attachments: ["/shot.png"], requestKey: "key" }]]);
  });

  it("starts a task's first run where the person chose", async () => {
    const { calls, submit } = submitter();
    await submit({ ...base, target: { kind: "task", taskId: "task", workspaceMode: "worktree" }, waitForSave: async () => undefined }, { text: "go", attachments: [] });
    expect(calls).toEqual([
      [
        "runs.start",
        {
          taskId: "task",
          workspaceMode: "worktree",
          agent: "codex",
          model: "gpt-5",
          effort: undefined,
          fastMode: false,
          attachments: [],
          mode: "act",
          permissionMode: "trusted",
          prompt: "go",
          resume: false,
        },
      ],
    ]);
  });

  it("fails with the reason when nothing can be sent", async () => {
    const { calls, submit } = submitter();
    await expect(submit({ ...base, choice: null, waitForSave: async () => undefined }, { text: "hi", attachments: [] })).rejects.toThrow("Choose a model first.");
    expect(calls).toEqual([]);
  });
});
