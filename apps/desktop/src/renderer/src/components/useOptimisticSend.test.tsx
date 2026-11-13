import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { emptyRun, type Block, type OutgoingMessage, type RunTranscript, type SubmitRequest } from "@openorc/client";

const { restored } = vi.hoisted(() => ({ restored: [] as unknown[] }));
vi.mock("../lib/composer-attachments", () => ({
  draftAttachments: (_key: string, paths: string[]) => paths.map((path) => ({ path, url: null, name: path })),
  restoreDraftAttachments: (_key: string, files: unknown[]) => restored.push(...files),
}));

import { useOptimisticSend } from "./useOptimisticSend";

afterEach(() => {
  cleanup();
  restored.length = 0;
});

const request: Omit<SubmitRequest, "now"> = {
  target: { kind: "thread", threadId: "home" },
  working: false,
  live: true,
  activeRun: { id: "run-1", agent: "codex", mode: "act", permissionMode: "autonomous" },
  agentsUsed: ["codex"],
  choice: { agent: "codex", model: "fixture", effort: null, fastMode: false },
  mode: "act",
  permission: "autonomous",
  permissionReady: true,
  compacting: false,
  waitForSave: async () => undefined,
};

function deferred() {
  let resolve!: (kind: "continue") => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<"continue">((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
}

function setup(calls: { request: SubmitRequest; message: OutgoingMessage; reply: ReturnType<typeof deferred> }[]) {
  const submitter = {
    pending: false,
    submit: (sent: SubmitRequest, message: OutgoingMessage) => {
      const reply = deferred();
      calls.push({ request: sent, message, reply });
      return reply.promise;
    },
  };
  const restore = vi.fn();
  const hook = renderHook(({ run, current }: { run: RunTranscript | null; current: typeof request }) => useOptimisticSend({ submitter, request: current, run, attachmentsKey: "draft", restore }), {
    initialProps: { run: null as RunTranscript | null, current: request },
  });
  return { hook, restore };
}

const recorded = (id: string, text: string): RunTranscript => {
  const run = emptyRun("run-1");
  const block: Block = { id, kind: "message", role: "user", text, streaming: false, at: 1 };
  return { ...run, blocks: [block], blockIndex: new Map([[id, 0]]) };
};

it("shows a message as sent at once, under the id the core records it with, and lets the recorded copy take its place", async () => {
  const calls: Parameters<typeof setup>[0] = [];
  const { hook } = setup(calls);
  await act(() => hook.result.current.send({ ...request, now: true }, { text: "hey", attachments: [] }));
  const echo = hook.result.current.run!.blocks.at(-1)!;
  expect(echo).toMatchObject({ role: "user", text: "hey", pending: true });
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]!.message.messageId).toBe(echo.id);

  hook.rerender({ run: recorded(echo.id, "hey"), current: request });
  expect(hook.result.current.run!.blocks.map((block) => block.id)).toEqual([echo.id]);
  expect(hook.result.current.run!.blocks[0]).not.toHaveProperty("pending");
});

it("gives a failed send back to the composer, words and files", async () => {
  const calls: Parameters<typeof setup>[0] = [];
  const { hook, restore } = setup(calls);
  await act(() => hook.result.current.send({ ...request, now: true }, { text: "see this", attachments: ["/tmp/shot.png"] }));
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  await act(async () => calls[0]!.reply.reject(new Error("offline")));
  expect(restore).toHaveBeenCalledWith("see this");
  expect(restored).toEqual([{ path: "/tmp/shot.png", url: null, name: "/tmp/shot.png" }]);
  expect(hook.result.current.run).toBeNull();
});

it("sends a second quick message only after the first took hold, planned on what the conversation then shows", async () => {
  const calls: Parameters<typeof setup>[0] = [];
  const { hook } = setup(calls);
  await act(() => hook.result.current.send({ ...request, now: true }, { text: "one", attachments: [] }));
  await act(() => hook.result.current.send({ ...request, now: true }, { text: "two", attachments: [] }));
  expect(hook.result.current.run!.blocks.map((block) => block.kind === "message" && block.text)).toEqual(["one", "two"]);
  await vi.waitFor(() => expect(calls).toHaveLength(1));

  await act(async () => calls[0]!.reply.resolve("continue"));
  hook.rerender({ run: null, current: { ...request, working: true } });
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]!.request.working).toBe(true);
  expect(calls[1]!.message.text).toBe("two");
});
