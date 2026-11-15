import { describe, expect, it } from "vitest";
import type { RpcMethod } from "@openorc/protocol";
import { composerActions, planSubmit, sendCluster, sendMessage, sendsNow, type SubmitCalls, type SubmitInput, type SubmitRequest } from "./conversation-submit.js";

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
      name: "steers OpenCode's running turn when asked now",
      input: { working: true, live: true, activeRun: { ...warm, agent: "opencode" }, choice: { ...codex, agent: "opencode" }, now: true },
      plan: { kind: "steer", runId: "A" },
    },
    { name: "queues while compacting", input: { working: true, live: true, activeRun: warm, compacting: true, now: true }, plan: { kind: "queue", threadId: "thread" } },
    { name: "never queues a task, which has no thread", input: { target: { kind: "task", taskId: "task" }, working: true, live: true, activeRun: warm }, plan: { kind: "continue", runId: "A" } },
    { name: "waits for saved permissions before starting", input: { permissionReady: false }, plan: { kind: "blocked", reason: "Wait for your saved permissions to load." } },
    { name: "needs a model", input: { choice: null }, plan: { kind: "blocked", reason: "Choose a model first." } },
    { name: "restarts fresh even beside a warm process", input: { restart: true, live: true, activeRun: warm, agentsUsed: ["codex"] }, plan: { kind: "start", choice: codex, resume: false } },
    { name: "restarts only once permissions are known", input: { restart: true, permissionReady: false, choice: null }, plan: { kind: "blocked", reason: "Wait for your saved permissions to load." } },
    {
      name: "goes on with another Claude account in a new process that resumes there",
      input: { claudeAccountId: "personal", live: true, activeRun: { ...warm, agent: "claude" }, agentsUsed: ["claude"], choice: { ...codex, agent: "claude" } },
      plan: { kind: "start", choice: { ...codex, agent: "claude" }, resume: true },
    },
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

describe("sendCluster", () => {
  const typed = { queueing: false, liveByDefault: true, steerable: false, canStop: false, hasDraft: true };
  it.each([false, true])("keeps one bare arrow in a read-only thread, with a running turn=%s", (working) => {
    for (const hasDraft of [false, true]) {
      for (const asked of [null, "The agent is waiting for an answer."]) {
        expect(sendCluster({ ...typed, readOnly: true, queueing: working, canStop: working, steerable: working, hasDraft, asked })).toEqual({ kind: "send", stop: false, startsTask: false });
      }
    }
  });

  it("keeps Post note where a block holds the reader's messages, since a note starts nothing", () => {
    expect(sendCluster({ ...typed, readOnly: true, note: true })).toEqual({ kind: "note", stop: false });
    expect(sendCluster({ ...typed, readOnly: true, note: true, hasDraft: false })).toEqual({ kind: "send", stop: false, startsTask: false });
  });

  it.each([
    { name: "a bare arrow with nothing running", input: typed, cluster: { kind: "send", stop: false, startsTask: false } },
    { name: "one ink Stop with nothing typed while a turn runs", input: { ...typed, queueing: true, canStop: true, hasDraft: false }, cluster: { kind: "stop" } },
    {
      name: "Send now on the pill and Queue beside it when the turn can take it",
      input: { ...typed, queueing: true, canStop: true, steerable: true },
      cluster: { kind: "turn", stop: true, enter: "now", other: { way: "queue", blocked: null } },
    },
    {
      name: "Queue on the pill when the person's default is to queue",
      input: { ...typed, queueing: true, canStop: true, steerable: true, liveByDefault: false },
      cluster: { kind: "turn", stop: true, enter: "queue", other: { way: "now", blocked: null } },
    },
    {
      name: "Queue on the pill and Send now dimmed with its reason when the turn cannot take it",
      input: { ...typed, queueing: true, canStop: true, steerReason: "This agent reads new messages after its turn. It will be queued." },
      cluster: { kind: "turn", stop: true, enter: "queue", other: { way: "now", blocked: "This agent reads new messages after its turn. It will be queued." } },
    },
    {
      name: "Stop alone as a white key while an ask waits and nothing is typed",
      input: { ...typed, queueing: true, canStop: true, hasDraft: false, asked: "Claude is waiting for your answer." },
      cluster: { kind: "asked" },
    },
    {
      name: "Queue on the pill and Send now dimmed with the ask's reason when a message is typed while an ask waits",
      input: { ...typed, queueing: true, canStop: true, steerable: true, asked: "Claude is waiting for your answer." },
      cluster: { kind: "turn", stop: true, enter: "queue", other: { way: "now", blocked: "Claude is waiting for your answer." } },
    },
    { name: "a task's empty first send names that it starts the task", input: { ...typed, hasDraft: false, startsTask: true }, cluster: { kind: "send", stop: false, startsTask: true } },
    { name: "Post note for a draft that tags a person, with nothing running", input: { ...typed, note: true }, cluster: { kind: "note", stop: false } },
    {
      name: "Post note with Stop beside it, never Send now or Queue, while a turn runs",
      input: { ...typed, note: true, queueing: true, canStop: true, steerable: true },
      cluster: { kind: "note", stop: true },
    },
    {
      name: "Post note while an ask waits, which the note never answers",
      input: { ...typed, note: true, queueing: true, canStop: true, asked: "Claude is waiting for your answer." },
      cluster: { kind: "note", stop: true },
    },
  ])("$name", ({ input, cluster }) => {
    expect(sendCluster(input)).toEqual(cluster);
  });

  it("sends into the turn by the pill's word, and Command and Enter by the other", () => {
    const now = sendCluster({ ...typed, queueing: true, canStop: true, steerable: true });
    expect([sendsNow(now, false), sendsNow(now, true)]).toEqual([true, false]);
    const queue = sendCluster({ ...typed, queueing: true, canStop: true });
    expect([sendsNow(queue, false), sendsNow(queue, true)]).toEqual([false, true]);
    expect(sendsNow(sendCluster(typed), true)).toBe(false);
    expect(sendsNow(sendCluster({ ...typed, note: true, queueing: true, steerable: true }), false)).toBe(false);
  });
});

describe("sendMessage", () => {
  function submitter() {
    const calls: Array<[RpcMethod, unknown]> = [];
    const call = (method: RpcMethod) => ({ mutateAsync: async (params: unknown) => void calls.push([method, params]) });
    const mutations = { start: call("runs.start"), send: call("runs.send"), queue: call("threads.queue") } as SubmitCalls;
    return { calls, submit: (request: SubmitRequest, message: { text: string; attachments: string[]; requestId?: string }) => sendMessage(mutations, () => "key", request, message) };
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

  it("joins the running turn its sender saw, when they name one, and names none otherwise", async () => {
    const { calls, submit } = submitter();
    const steering = { ...base, working: true, live: true, activeRun: warm, now: true, waitForSave: async () => undefined };
    await submit({ ...steering, expectedTurnId: "turn-seen" }, { text: "Use the other file", attachments: [] });
    await submit(steering, { text: "Use the other file", attachments: [] });
    expect(calls.map(([method, params]) => [method, (params as { expectedTurnId?: string }).expectedTurnId])).toEqual([
      ["runs.send", "turn-seen"],
      ["runs.send", undefined],
    ]);
  });

  it("names the Claude account a conversation goes on with", async () => {
    const { calls, submit } = submitter();
    await submit({ ...base, claudeAccountId: "personal", waitForSave: async () => undefined }, { text: "Continue.", attachments: [] });
    expect(calls).toEqual([["runs.start", expect.objectContaining({ threadId: "thread", prompt: "Continue.", resume: true, claudeAccountId: "personal" })]]);
  });

  it("sends a message under its own request id whichever way it goes, before a task's", async () => {
    const { calls, submit } = submitter();
    const task = { context: { id: "task", ifRevision: 2 }, requestId: "task-request" };
    const files = { text: "notes", attachments: ["/hosted/files/f1/a.pdf"], requestId: "exact" };
    await submit({ ...base, task, waitForSave: async () => undefined }, files);
    await submit({ ...base, working: true, live: true, activeRun: warm, waitForSave: async () => undefined }, files);
    await submit({ ...base, working: true, live: true, activeRun: warm, now: true, waitForSave: async () => undefined }, files);
    await submit({ ...base, task, waitForSave: async () => undefined }, { text: "go", attachments: [] });
    expect(calls).toEqual([
      ["runs.start", expect.objectContaining({ messageId: "exact", task: task.context })],
      ["threads.queue", expect.objectContaining({ requestKey: "exact" })],
      ["runs.send", expect.objectContaining({ runId: "A", messageId: "exact" })],
      ["runs.start", expect.objectContaining({ messageId: "task-request" })],
    ]);
  });

  it("fails with the reason when nothing can be sent", async () => {
    const { calls, submit } = submitter();
    await expect(submit({ ...base, choice: null, waitForSave: async () => undefined }, { text: "hi", attachments: [] })).rejects.toThrow("Choose a model first.");
    expect(calls).toEqual([]);
  });
});
