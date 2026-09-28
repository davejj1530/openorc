import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtectedSecretsClient } from "./protected-secrets";

afterEach(() => {
  vi.useRealTimers();
});
describe("protected storage client", () => {
  it("matches replies by both ID and store, accepting out-of-order replies", async () => {
    const send = vi.fn();
    const client = new ProtectedSecretsClient(send);
    const memory = client.store("memory.secrets").load();
    const slack = client.store("slack.secrets").load();
    const memoryId = send.mock.calls[0]![0].id;
    const slackId = send.mock.calls[1]![0].id;
    client.receive({ type: "slack.secrets.result", id: memoryId, value: "wrong-store-fixture" });
    client.receive({ type: "slack.secrets.result", id: slackId, value: "slack-fixture" });
    client.receive({ type: "memory.secrets.result", id: memoryId, value: "memory-fixture" });
    await expect(memory).resolves.toBe("memory-fixture");
    await expect(slack).resolves.toBe("slack-fixture");
    expect(client.receive({ type: "shutdown" })).toBe(false);
  });

  it("answers the reviewer app's store on its own channel", async () => {
    const send = vi.fn();
    const client = new ProtectedSecretsClient(send);
    const key = client.store("github.secrets").load();
    expect(send.mock.calls[0]![0]).toMatchObject({ type: "github.secrets", operation: "load" });
    client.receive({ type: "github.secrets.result", id: send.mock.calls[0]![0].id, value: "key-fixture" });
    await expect(key).resolves.toBe("key-fixture");
  });

  it("times out, ignores late replies, and accepts a subsequent request", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const client = new ProtectedSecretsClient(send);
    const promise = client.store("memory.secrets").load();
    const rejection = expect(promise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    client.receive({ type: "memory.secrets.result", id: send.mock.calls[0]![0].id, value: "late-fixture" });
    const retry = client.store("memory.secrets").load();
    client.receive({ type: "memory.secrets.result", id: send.mock.calls[1]![0].id, value: null });
    await expect(retry).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sanitizes send failures and returned errors, clearing request timers", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockImplementationOnce(() => {
      throw new Error("raw-secret-fixture");
    });
    const client = new ProtectedSecretsClient(send);
    await expect(client.store("memory.secrets").save("fixture")).rejects.toThrow("Protected storage is unavailable.");
    const retry = client.store("memory.secrets").load();
    client.receive({ type: "memory.secrets.result", id: send.mock.calls[1]![0].id, error: "raw-secret-fixture" });
    await expect(retry).rejects.toThrow("Cannot access protected storage.");
    expect(vi.getTimerCount()).toBe(0);
  });
});
