import { expect, it, vi } from "vitest";
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
