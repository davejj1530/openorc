import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserClient } from "./browser-client";

afterEach(() => vi.useRealTimers());
describe("browser utility bridge", () => {
  it("correlates simultaneous conversations and propagates host errors", async () => {
    const send = vi.fn();
    const client = new BrowserClient(send);
    const a = client.execute("thread:a", { action: "snapshot" });
    const b = client.execute("thread:b", { action: "screenshot" });
    expect(send.mock.calls.map(([message]) => message.surface)).toEqual(["thread:a", "thread:b"]);
    expect(client.receive({ type: "unrelated" })).toBe(false);
    client.receive({ type: "browser.result", id: 2, result: { url: "http://localhost/b", title: "B" } });
    client.receive({ type: "browser.result", id: 1, error: "Closed preview" });
    await expect(a).rejects.toThrow("Closed preview");
    await expect(b).resolves.toMatchObject({ title: "B" });
  });
  it("bounds requests when the host is unavailable and ignores late replies", async () => {
    vi.useFakeTimers();
    const client = new BrowserClient(() => {});
    const result = client.execute("thread:a", { action: "snapshot" });
    const rejected = expect(result).rejects.toThrow("did not respond");
    await vi.advanceTimersByTimeAsync(35000);
    await rejected;
    expect(client.receive({ type: "browser.result", id: 1, result: { url: "", title: "late" } })).toBe(true);
    const offline = new BrowserClient(() => {
      throw new Error("gone");
    });
    await expect(offline.execute("thread:a", { action: "snapshot" })).rejects.toThrow("unavailable");
  });
});
