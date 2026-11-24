import { expect, it, vi } from "vitest";
import type { ClientPush } from "@openorc/client";
import { core } from "./rpc";

it("only accepts the preload's window message when connecting the privileged core port", async () => {
  Object.defineProperty(window, "openorc", { configurable: true, value: { connectBridge: vi.fn() } });
  core.connect();
  const foreign = document.createElement("iframe");
  document.body.append(foreign);
  const forged = { start: vi.fn(), postMessage: vi.fn(), onmessage: null };
  window.dispatchEvent(new MessageEvent("message", { data: "openorc:port", source: foreign.contentWindow, ports: [forged as unknown as MessagePort] }));
  expect(forged.start).not.toHaveBeenCalled();
  const trusted = { start: vi.fn(), postMessage: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };
  window.dispatchEvent(new MessageEvent("message", { data: "openorc:port", source: window, ports: [trusted as unknown as MessagePort] }));
  expect(trusted.start).toHaveBeenCalledOnce();
  const pending = core.call("mcpApps.close", { runId: "run-1", viewId: "00000000-0000-4000-8000-000000000000" });
  expect(trusted.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "rpc", method: "mcpApps.close" }));
  const request = trusted.postMessage.mock.calls[0]![0];
  trusted.onmessage!(new MessageEvent("message", { data: { type: "rpc.result", id: request.id, result: null } }));
  await expect(pending).resolves.toBeNull();
  foreign.remove();
});

it("tells the client what the port pushes, with a core that starts again as a resumed session", () => {
  Object.defineProperty(window, "openorc", { configurable: true, value: { connectBridge: vi.fn() } });
  core.connect();
  const port = { start: vi.fn(), postMessage: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };
  window.dispatchEvent(new MessageEvent("message", { data: "openorc:port", source: window, ports: [port as unknown as MessagePort] }));
  const heard: ClientPush[] = [];
  const stop = core.onPush((push) => heard.push(push));
  const frame = { runId: "run", seq: 1, events: [] };
  const notice = { kind: "finished" as const, threadId: "thread", taskId: null, title: "Done", body: "Reply ready" };
  for (const data of [
    { type: "ready", pid: 1, mcpPort: 9 },
    { type: "frame", frame },
    { type: "invalidate", keys: ["threads"] },
    { type: "notify", ...notice },
    { type: "log", level: "info", message: "x" },
    { type: "ready", pid: 2, mcpPort: 10 },
  ])
    port.onmessage!(new MessageEvent("message", { data }));
  stop();
  expect(heard).toEqual([
    { type: "session", resumed: false },
    { type: "frame", frame },
    { type: "invalidate", keys: ["threads"] },
    { type: "notify", notice },
    { type: "session", resumed: true },
  ]);
  expect(core.ready).toEqual({ mcpPort: 10 });
});

it("hands the window's media port to device streams, including ones that start listening later", () => {
  Object.defineProperty(window, "openorc", { configurable: true, value: { connectBridge: vi.fn() } });
  core.connect();
  const early = vi.fn();
  const stop = core.onMediaPort(early);
  const rpc = { start: vi.fn(), postMessage: vi.fn(), onmessage: null };
  const media = { start: vi.fn(), postMessage: vi.fn(), onmessage: null };
  window.dispatchEvent(new MessageEvent("message", { data: "openorc:port", source: window, ports: [rpc, media] as unknown as MessagePort[] }));
  expect(early).toHaveBeenCalledWith(media);
  const late = vi.fn();
  core.onMediaPort(late);
  expect(late).toHaveBeenCalledWith(media);
  stop();
});

it("fails what a core that stopped never answered, and sends later calls to the core that takes its place", async () => {
  Object.defineProperty(window, "openorc", { configurable: true, value: { connectBridge: vi.fn() } });
  core.connect();
  const port = () => ({ start: vi.fn(), postMessage: vi.fn(), close: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null });
  const first = port();
  window.dispatchEvent(new MessageEvent("message", { data: "openorc:port", source: window, ports: [first as unknown as MessagePort] }));
  first.onmessage!(new MessageEvent("message", { data: { type: "ready", pid: 1, mcpPort: 9 } }));
  const unanswered = core.call("threads.messages", { id: "thread" });

  // Only the preload says the core stopped; a frame in the page cannot.
  const foreign = document.createElement("iframe");
  document.body.append(foreign);
  window.dispatchEvent(new MessageEvent("message", { data: "openorc:core-lost", source: foreign.contentWindow }));
  expect(first.close).not.toHaveBeenCalled();
  foreign.remove();

  window.dispatchEvent(new MessageEvent("message", { data: "openorc:core-lost", source: window }));
  await expect(unanswered).rejects.toThrow("OpenOrc stopped before answering");
  expect(first.close).toHaveBeenCalledOnce();
  expect(core.startup).toBe("OpenOrc stopped unexpectedly. Starting it again…");

  const later = core.call("threads.messages", { id: "thread" });
  expect(first.postMessage).toHaveBeenCalledOnce();
  const heard: ClientPush[] = [];
  const stop = core.onPush((push) => heard.push(push));
  const second = port();
  window.dispatchEvent(new MessageEvent("message", { data: "openorc:port", source: window, ports: [second as unknown as MessagePort] }));
  const request = second.postMessage.mock.calls[0]![0];
  expect(request).toMatchObject({ type: "rpc", method: "threads.messages" });
  second.onmessage!(new MessageEvent("message", { data: { type: "ready", pid: 2, mcpPort: 10 } }));
  second.onmessage!(new MessageEvent("message", { data: { type: "rpc.result", id: request.id, result: [] } }));
  await expect(later).resolves.toEqual([]);
  expect(core.startup).toBeNull();
  expect(heard).toEqual([{ type: "session", resumed: true }]);
  stop();
});
