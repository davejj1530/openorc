import { expect, it, vi } from "vitest";
import { sendMessage, type SubmitCalls, type SubmitRequest } from "./conversation-submit.js";

const request = (patch: Partial<SubmitRequest> = {}): SubmitRequest => ({
  target: { kind: "thread", threadId: "shared-thread" },
  working: false,
  live: false,
  activeRun: undefined,
  agentsUsed: [],
  choice: { agent: "codex", model: "model-one", effort: null },
  mode: "act",
  permission: "review",
  permissionReady: true,
  compacting: false,
  now: false,
  waitForSave: async () => undefined,
  task: { context: { id: "online-task", ifRevision: 4 }, requestId: "d5350a32-c6d3-4a7b-8811-0ecae0b1630c" },
  ...patch,
});
const message = { text: "Keep my words", attachments: [] };
const nextId = () => "another-message";
const calls = (): SubmitCalls => ({
  start: { mutateAsync: vi.fn().mockResolvedValue(null) },
  send: { mutateAsync: vi.fn().mockResolvedValue(null) },
  queue: { mutateAsync: vi.fn().mockResolvedValue([]) },
});

it("carries one captured task context and message id through an ordinary start and its lost-reply retry", async () => {
  const actions = calls(),
    input = request();
  vi.mocked(actions.start.mutateAsync).mockRejectedValueOnce(new TypeError("Reply lost"));
  await expect(sendMessage(actions, nextId, input, message)).rejects.toThrow("Reply lost");
  await sendMessage(actions, nextId, input, message);
  expect(actions.start.mutateAsync).toHaveBeenCalledTimes(2);
  expect(vi.mocked(actions.start.mutateAsync).mock.calls[0]?.[0]).toMatchObject({ task: input.task?.context, messageId: input.task?.requestId });
  expect(vi.mocked(actions.start.mutateAsync).mock.calls[0]).toEqual(vi.mocked(actions.start.mutateAsync).mock.calls[1]);
});
it("retains task context and the same message identity when a turn is queued", async () => {
  const actions = calls(),
    input = request({ working: true });
  await sendMessage(actions, nextId, input, message);
  expect(actions.queue.mutateAsync).toHaveBeenCalledExactlyOnceWith({ id: "shared-thread", ...message, task: input.task?.context, requestKey: input.task?.requestId });
});
it("retains task context when an existing process continues", async () => {
  const actions = calls(),
    input = request({ live: true, activeRun: { id: "hosted:shared-thread", agent: "codex", mode: "act", permissionMode: "review" } });
  await sendMessage(actions, nextId, input, message);
  expect(actions.send.mutateAsync).toHaveBeenCalledExactlyOnceWith({ runId: "hosted:shared-thread", ...message, task: input.task?.context, messageId: input.task?.requestId });
});
