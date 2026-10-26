import { afterEach, expect, it, vi } from "vitest";
import { PreviewClient } from "./preview-client";

afterEach(() => vi.useRealTimers());

it("asks main over the utility channel and resolves by request id", async () => {
  const sent: { type: string; id: number }[] = [];
  const client = new PreviewClient((message) => sent.push(message as { type: string; id: number }));
  const page = client.host.query("t1");
  const capture = client.host.capture("t1", { width: 786, quality: 60, unless: null });
  expect(sent).toEqual([
    { type: "preview.query", id: 1, threadId: "t1" },
    { type: "preview.capture", id: 2, threadId: "t1", width: 786, quality: 60, unless: null },
  ]);
  const jpeg = new Uint8Array([1, 2, 3]);
  expect(client.receive({ type: "preview.result", id: 2, result: { kind: "frame", pane: "p", jpeg, width: 786, height: 1039, digest: "d" } })).toBe(true);
  expect(client.receive({ type: "preview.result", id: 1, result: null })).toBe(true);
  expect(await page).toBeNull();
  expect(await capture).toMatchObject({ kind: "frame", jpeg });
  expect(client.receive({ type: "browser.result", id: 1 })).toBe(false);
});

it("gives up after 5 seconds and turns main's error into a rejection", async () => {
  vi.useFakeTimers();
  const client = new PreviewClient(() => undefined);
  const waiting = client.host.query("t1");
  const failing = client.host.capture("t1", { width: 786, quality: 60, unless: null });
  client.receive({ type: "preview.result", id: 2, result: null, error: "The pane is gone." });
  await expect(failing).rejects.toThrow("The pane is gone.");
  const timedOut = expect(waiting).rejects.toThrow("The Mac's Preview did not answer.");
  await vi.advanceTimersByTimeAsync(5_000);
  await timedOut;
});

it("hands each change to every listener until it stops listening", () => {
  const client = new PreviewClient(() => undefined);
  const heard: [string, boolean][] = [];
  const off = client.host.onChange((threadId, lifecycle) => heard.push([threadId, lifecycle]));
  expect(client.receive({ type: "preview.changed", threadId: "t1", lifecycle: true })).toBe(true);
  off();
  client.receive({ type: "preview.changed", threadId: "t1", lifecycle: false });
  expect(heard).toEqual([["t1", true]]);
});

it("tells main a deleted thread is gone, and expects no answer", () => {
  const sent: unknown[] = [];
  const client = new PreviewClient((message) => sent.push(message));
  client.host.threadGone("t1");
  expect(sent).toEqual([{ type: "preview.gone", threadId: "t1" }]);
  const closed = new PreviewClient(() => {
    throw new Error("channel closed");
  });
  expect(() => closed.host.threadGone("t1")).not.toThrow();
});

it("sends a phone's input to main as one request and resolves with main's answer", async () => {
  const sent: unknown[] = [];
  const client = new PreviewClient((message) => sent.push(message));
  const request = { pane: "abc123abc123", frame: { width: 786, height: 566 }, input: { kind: "tap" as const, x: 393, y: 283, count: 1 } };
  const applied = client.host.input("t1", request);
  expect(sent).toEqual([{ type: "preview.input", id: 1, threadId: "t1", ...request }]);
  client.receive({ type: "preview.result", id: 1, result: { kind: "refused", reason: "busy" } });
  expect(await applied).toEqual({ kind: "refused", reason: "busy" });
});
