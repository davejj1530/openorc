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
  const pending = core.call("mcpApps.close", { viewId: "00000000-0000-4000-8000-000000000000" });
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
