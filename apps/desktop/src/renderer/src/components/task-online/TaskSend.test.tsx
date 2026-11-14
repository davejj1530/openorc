import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { SubmitPlan, SubmitRequest } from "@openorc/client";
import { useOptimisticSend } from "../useOptimisticSend";

const request = (id: string): SubmitRequest => ({
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
  task: { context: { id, ifRevision: 4 }, requestId: crypto.randomUUID() },
});

it("awaits the actual task send and keeps its captured context when the next draft changes", async () => {
  let finish: (kind: SubmitPlan["kind"]) => void = () => undefined;
  const pending = new Promise<SubmitPlan["kind"]>((resolve) => {
    finish = resolve;
  });
  const submit = vi.fn(() => pending),
    restore = vi.fn();
  const input = request("first-task");
  const hook = renderHook(({ current }) => useOptimisticSend({ submitter: { submit, pending: true }, request: current, run: null, attachmentsKey: "test-files", restore }), {
    initialProps: { current: input },
  });
  let done = false;
  let sent: Promise<void> = Promise.resolve();
  act(() => {
    sent = hook.result.current.send(input, { text: "My task words", attachments: [] }).then(() => {
      done = true;
    });
    hook.rerender({ current: request("next-task") });
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(done).toBe(false);
  expect(submit).toHaveBeenCalledExactlyOnceWith(input, { text: "My task words", attachments: [] });
  await act(async () => {
    finish("start");
    await sent;
  });
  expect(done).toBe(true);
  expect(restore).not.toHaveBeenCalled();
});
