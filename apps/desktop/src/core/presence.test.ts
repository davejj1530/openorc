import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installPresence } from "../main/presence-ipc";
import { PresenceClient } from "./presence";

/** The core's client and main's responder, joined the way the utility process joins them. */
function connect(idleState: () => string) {
  const child = new EventEmitter() as EventEmitter & { postMessage(message: unknown): void };
  const client = new PresenceClient((message) => child.emit("message", message));
  child.postMessage = vi.fn((message) => {
    client.receive(message);
  });
  installPresence(child, idleState);
  return { client, child };
}

describe("whether someone is using the Mac", () => {
  it("is asked of main, which reads input in the last two minutes as in use", async () => {
    const idle = vi.fn(() => "active");
    const { client } = connect(idle);
    await expect(client.inUse()).resolves.toBe(true);
    for (const state of ["idle", "locked", "unknown"]) {
      idle.mockReturnValue(state);
      await expect(client.inUse()).resolves.toBe(false);
    }
    expect(idle).toHaveBeenCalledTimes(4);
  });

  it("reads as away when main is missing, slow, fails, or the channel is gone", async () => {
    const silent = new PresenceClient(() => {});
    const started = Date.now();
    await expect(silent.inUse()).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);

    const failing = connect(() => {
      throw new Error("powerMonitor is not ready");
    });
    await expect(failing.client.inUse()).resolves.toBe(false);

    const gone = new PresenceClient(() => {
      throw new Error("parent port closed");
    });
    await expect(gone.inUse()).resolves.toBe(false);
  });

  it("leaves every other message alone, on both sides", () => {
    const { client, child } = connect(() => "active");
    expect(client.receive({ type: "browser.result", id: 1 })).toBe(false);
    expect(client.receive({ type: "presence.result", id: 99, inUse: true })).toBe(true);
    child.emit("message", { type: "presence", id: "1" });
    child.emit("message", { type: "memory.secrets", id: 1 });
    expect(child.postMessage).not.toHaveBeenCalled();
  });
});
