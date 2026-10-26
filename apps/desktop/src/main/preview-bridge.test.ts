import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { PreviewHost, PreviewHostInput } from "@openorc/protocol";
import { installBrowserBridge } from "./browser-bridge";
import { installPreviewBridge } from "./preview-bridge";

function child() {
  return Object.assign(new EventEmitter(), { postMessage: vi.fn() });
}

function fakeHost() {
  const listeners = new Set<(threadId: string, lifecycle: boolean) => void>();
  const host = {
    query: vi.fn(async (threadId: string) => ({ pane: "abc123abc123", url: `http://127.0.0.1:47831/${threadId}`, title: "QA Page", loading: false, error: null, crashed: false })),
    capture: vi.fn(async () => ({ kind: "same" as const })),
    input: vi.fn(async (): Promise<PreviewHostInput | null> => ({ kind: "applied", focus: null })),
    onChange: (listener: (threadId: string, lifecycle: boolean) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    threadGone: vi.fn((_threadId: string) => undefined),
  } satisfies PreviewHost;
  return { host, change: (threadId: string, lifecycle: boolean) => listeners.forEach((listener) => listener(threadId, lifecycle)) };
}

it("answers the core's query and capture by request id", async () => {
  const core = child();
  const { host } = fakeHost();
  installPreviewBridge(core, host);
  core.emit("message", { type: "preview.query", id: 1, threadId: "t1" });
  core.emit("message", { type: "preview.capture", id: 2, threadId: "t1", width: 786, quality: 60, unless: "d1" });
  await vi.waitFor(() => expect(core.postMessage).toHaveBeenCalledTimes(2));
  expect(host.capture).toHaveBeenCalledExactlyOnceWith("t1", { width: 786, quality: 60, unless: "d1" });
  expect(core.postMessage.mock.calls.map(([reply]) => reply)).toEqual([
    { type: "preview.result", id: 1, result: expect.objectContaining({ url: "http://127.0.0.1:47831/t1" }) },
    { type: "preview.result", id: 2, result: { kind: "same" } },
  ]);
});

it("refuses a malformed request without asking the host", async () => {
  const core = child();
  const { host } = fakeHost();
  installPreviewBridge(core, host);
  for (const bad of [
    { type: "preview.query", id: 1, threadId: "../etc" },
    { type: "preview.query", id: 2, threadId: "task:t1" },
    { type: "preview.capture", id: 3, threadId: "t1", width: 4000, quality: 60, unless: null },
    { type: "preview.capture", id: 4, threadId: "t1", width: 786, quality: 0, unless: null },
    { type: "preview.capture", id: 5, threadId: "t1", width: 786, quality: 60 },
  ])
    core.emit("message", bad);
  core.emit("message", { type: "preview.query", id: 1.5, threadId: "t1" });
  await vi.waitFor(() => expect(core.postMessage).toHaveBeenCalledTimes(5));
  expect(host.query).not.toHaveBeenCalled();
  expect(host.capture).not.toHaveBeenCalled();
  for (const [reply] of core.postMessage.mock.calls) expect(reply).toMatchObject({ type: "preview.result", result: null, error: "Invalid Preview request." });
});

it("closes a deleted thread's pages when the core names it, unanswered, and nothing else under that name", () => {
  const core = child();
  const { host } = fakeHost();
  installPreviewBridge(core, host);
  core.emit("message", { type: "preview.gone", threadId: "t1" });
  for (const bad of [{ type: "preview.gone", threadId: "task:t1" }, { type: "preview.gone", threadId: "t2", surface: "thread:t3" }, { type: "preview.gone" }]) core.emit("message", bad);
  expect(host.threadGone.mock.calls).toEqual([["t1"]]);
  expect(core.postMessage).not.toHaveBeenCalled();
});

it("tells the core when a thread's Preview changes, and says why a capture failed", async () => {
  const core = child();
  const { host, change } = fakeHost();
  host.capture.mockRejectedValueOnce(new Error("The pane is gone."));
  installPreviewBridge(core, host);
  change("t1", true);
  change("t1", false);
  core.emit("message", { type: "preview.capture", id: 9, threadId: "t1", width: 786, quality: 60, unless: null });
  await vi.waitFor(() => expect(core.postMessage).toHaveBeenCalledTimes(3));
  expect(core.postMessage.mock.calls.map(([reply]) => reply)).toEqual([
    { type: "preview.changed", threadId: "t1", lifecycle: true },
    { type: "preview.changed", threadId: "t1", lifecycle: false },
    { type: "preview.result", id: 9, result: null, error: "The pane is gone." },
  ]);
  core.emit("exit", 0);
  change("t1", true);
  expect(core.postMessage).toHaveBeenCalledTimes(3);
});

it("keeps the agent's channel and the phone's apart: no frame action reaches the browser host, no browser command the Preview", async () => {
  const core = child();
  const execute = vi.fn(async () => ({ url: "http://127.0.0.1:47831/", title: "QA Page" }));
  const { host } = fakeHost();
  installBrowserBridge(core, execute);
  installPreviewBridge(core, host);
  core.emit("message", { type: "browser.command", id: 1, surface: "thread:t1", command: { action: "frame" } });
  core.emit("message", { type: "preview.capture", id: 2, surface: "thread:t1", command: { action: "click", ref: "e1" } });
  core.emit("message", { type: "preview.query", id: 3, threadId: "t1", command: { action: "open", url: "https://example.com" } });
  await vi.waitFor(() => expect(core.postMessage).toHaveBeenCalledTimes(3));
  expect(execute).not.toHaveBeenCalled();
  expect(core.postMessage.mock.calls.map(([reply]) => reply)).toEqual([
    { type: "browser.result", id: 1, error: "Invalid sidebar browser command." },
    { type: "preview.result", id: 2, result: null, error: "Invalid Preview request." },
    { type: "preview.result", id: 3, result: null, error: "Invalid Preview request." },
  ]);
});

const tap = { kind: "tap", x: 393, y: 283, count: 1 };
const input = (id: number, extra: Record<string, unknown> = {}) => ({ type: "preview.input", id, threadId: "t1", pane: "abc123abc123", frame: { width: 786, height: 566 }, input: tap, ...extra });

it("applies a phone's input through the host, answered by request id", async () => {
  const core = child();
  const { host } = fakeHost();
  host.input.mockResolvedValueOnce({ kind: "applied", focus: { kind: "text", keyboard: "email", enter: "go", secure: false, multiline: false } });
  installPreviewBridge(core, host);
  core.emit("message", input(4));
  core.emit("message", input(5, { input: { kind: "text", text: "hi" } }));
  await vi.waitFor(() => expect(core.postMessage).toHaveBeenCalledTimes(2));
  expect(host.input.mock.calls).toEqual([
    ["t1", { pane: "abc123abc123", frame: { width: 786, height: 566 }, input: tap }],
    ["t1", { pane: "abc123abc123", frame: { width: 786, height: 566 }, input: { kind: "text", text: "hi" } }],
  ]);
  expect(core.postMessage.mock.calls.map(([reply]) => reply)).toEqual([
    { type: "preview.result", id: 4, result: { kind: "applied", focus: { kind: "text", keyboard: "email", enter: "go", secure: false, multiline: false } } },
    { type: "preview.result", id: 5, result: { kind: "applied", focus: null } },
  ]);
});

it("refuses an input outside its exact shape, one that names a surface or a command above all", async () => {
  const core = child();
  const { host } = fakeHost();
  installPreviewBridge(core, host);
  const bad = [
    input(1, { surface: "thread:t1" }),
    input(2, { command: { action: "click", ref: "e1" } }),
    input(3, { input: { action: "click", ref: "e1" } }),
    input(4, { input: { ...tap, button: "right" } }),
    input(5, { pane: "thread:t1" }),
    input(6, { threadId: "task:t1" }),
    input(7, { frame: { width: 786 } }),
    input(8, { input: { kind: "key", key: "Meta", count: 1 } }),
  ];
  for (const message of bad) core.emit("message", message);
  await vi.waitFor(() => expect(core.postMessage).toHaveBeenCalledTimes(bad.length));
  expect(host.input).not.toHaveBeenCalled();
  for (const [reply] of core.postMessage.mock.calls) expect(reply).toMatchObject({ type: "preview.result", result: null, error: "Invalid Preview request." });
});

it("never lets the agent's channel carry a phone's input, nor the phone's an agent command", async () => {
  const core = child();
  const execute = vi.fn(async () => ({ url: "http://127.0.0.1:47831/", title: "QA Page" }));
  const { host } = fakeHost();
  installBrowserBridge(core, execute);
  installPreviewBridge(core, host);
  core.emit("message", { type: "browser.command", id: 1, surface: "thread:t1", command: { action: "tap", x: 10, y: 10 } });
  core.emit("message", { type: "browser.command", id: 2, surface: "thread:t1", command: tap });
  core.emit("message", input(3, { input: { action: "open", url: "https://example.com" } }));
  await vi.waitFor(() => expect(core.postMessage).toHaveBeenCalledTimes(3));
  expect(execute).not.toHaveBeenCalled();
  expect(host.input).not.toHaveBeenCalled();
  expect(core.postMessage.mock.calls.map(([reply]) => reply)).toEqual([
    { type: "browser.result", id: 1, error: "Invalid sidebar browser command." },
    { type: "browser.result", id: 2, error: "Invalid sidebar browser command." },
    { type: "preview.result", id: 3, result: null, error: "Invalid Preview request." },
  ]);
});
