import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeCore, closeCoreForUpdate } from "./update-handoff";

class Child extends EventEmitter {
  request: { type: string; id: string; purpose?: string } | null = null;
  postMessage(message: { type: string; id: string; purpose?: string }) {
    this.request = message;
  }
  reply(type: string, reason?: string, more: object = {}) {
    this.emit("message", { type, id: this.request?.id, reason, ...more });
  }
}
afterEach(() => vi.useRealTimers());
describe("update shutdown handoff", () => {
  it("waits for both the matching reservation and a clean process exit", async () => {
    const child = new Child();
    const settled = vi.fn();
    const result = closeCoreForUpdate(child).then(settled);
    child.emit("message", { type: "update:blocked", id: "another-request", reason: "Busy" });
    child.reply("update:prepared");
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.emit("exit", 0);
    await result;
    expect(settled).toHaveBeenCalledWith(null);
    expect(child.listenerCount("message")).toBe(0);
  });

  it("leaves a busy core running and returns its reason", async () => {
    const child = new Child();
    const result = closeCoreForUpdate(child);
    child.reply("update:blocked", "Agent still running");
    await expect(result).resolves.toBe("Agent still running");
    expect(child.listenerCount("exit")).toBe(0);
  });

  it.each([false, true])("refuses an unconfirmed or unsuccessful exit (prepared=%s)", async (prepared) => {
    const child = new Child();
    const result = closeCoreForUpdate(child);
    if (prepared) child.reply("update:prepared");
    child.emit("exit", prepared ? 1 : 0);
    await expect(result).rejects.toThrow("clean shutdown");
  });

  it("times out without killing the core or treating a late reply as success", async () => {
    vi.useFakeTimers();
    const child = new Child();
    const result = expect(closeCoreForUpdate(child, 100)).rejects.toThrow("not installed");
    await vi.advanceTimersByTimeAsync(100);
    await result;
    child.reply("update:prepared");
    child.emit("exit", 0);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("asks for a switch by name, and says whether a refusal passes by itself", async () => {
    const child = new Child();
    const busy = closeCore(child, "switch");
    expect(child.request?.purpose).toBe("switch");
    child.reply("update:blocked", "OpenOrc is processing a request. Try again in a moment.", { retry: true });
    await expect(busy).resolves.toEqual({ reason: "OpenOrc is processing a request. Try again in a moment.", retry: true });
    const working = closeCore(child, "switch");
    child.reply("update:blocked", "Wait for agent work to finish first, then switch.");
    await expect(working).resolves.toEqual({ reason: "Wait for agent work to finish first, then switch.", retry: false });
    const update = closeCore(child, "update");
    expect(child.request?.purpose).toBeUndefined();
    child.reply("update:prepared");
    child.emit("exit", 0);
    await expect(update).resolves.toBeNull();
  });

  it("says a switch that could not close left OpenOrc where it was", async () => {
    const child = new Child();
    const result = closeCore(child, "switch");
    child.emit("exit", 1);
    await expect(result).rejects.toThrow("The core did not confirm a clean shutdown. OpenOrc is still running where it was.");
  });
});
