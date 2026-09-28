import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeCoreForUpdate } from "./update-handoff";

class Child extends EventEmitter {
  request: { type: string; id: string } | null = null;
  postMessage(message: { type: string; id: string }) {
    this.request = message;
  }
  reply(type: string, reason?: string) {
    this.emit("message", { type, id: this.request?.id, reason });
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
});
