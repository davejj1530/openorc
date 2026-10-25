import { afterEach, describe, expect, it, vi } from "vitest";
import type { MacMessage, MacSession, PhoneMessage } from "@openorc/link";
import type { RemotePush } from "@openorc/protocol";
import type { RpcReply } from "../transport.js";
import { RemoteSession, type Answer, type SessionDeps } from "./session.js";

/** Stands in for a link session: records what the Mac sends and lets the test set how far behind the socket is. */
class FakeLink {
  readonly sent: MacMessage[] = [];
  /** Byte streams handed over and not yet on the network; `sent()` finishes one. */
  readonly streams: Array<{ id: number; sent(): void }> = [];
  buffered = 0;
  closed = false;
  private messageListener: (message: PhoneMessage) => void = () => {};
  private readonly closeListeners: Array<() => void> = [];

  send(message: MacMessage): void {
    if (!this.closed) this.sent.push(message);
  }
  sendBytes(id: number): Promise<void> {
    return new Promise((sent) => this.streams.push({ id, sent }));
  }
  bufferedAmount(): number {
    return this.buffered;
  }
  onMessage(listener: (message: PhoneMessage) => void): () => void {
    this.messageListener = listener;
    return () => {};
  }
  onClose(listener: () => void): () => void {
    this.closeListeners.push(listener);
    return () => {};
  }
  close(): void {
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }
  receive(message: PhoneMessage): void {
    this.messageListener(message);
  }
}

function session(
  answer: Answer = async (request) => ({ type: "rpc.result", id: request.id, result: null }),
  readAsset: SessionDeps["readAsset"] = async () => ({ ok: false, reason: "missing" }),
  device: SessionDeps["device"] = async () => "no-key",
) {
  const link = new FakeLink();
  const remote = new RemoteSession("device", link as unknown as MacSession, { answer, guard: { attachmentsDir: "/data/attachments" }, readAsset, device });
  return { link, remote };
}

const frame = (runId: string, seq = 1): RemotePush => ({ type: "frame", frame: { runId, seq, events: [] } });
function label(message: MacMessage): string {
  if (message.t !== "push") return message.t;
  return message.push.type === "frame" ? `frame:${message.push.frame.runId}` : message.push.type;
}
const pushed = (link: FakeLink) => link.sent.map(label);

afterEach(() => {
  vi.useRealTimers();
});

describe("a phone session", () => {
  it("sends pushes together after 50 ms, frames only for runs the phone asked for", async () => {
    vi.useFakeTimers();
    const { link, remote } = session();
    link.receive({ t: "interest", runIds: ["wanted"] });
    remote.push(frame("wanted"));
    remote.push(frame("other"));
    remote.push({ type: "invalidate", keys: ["threads"] });
    await vi.advanceTimersByTimeAsync(49);
    expect(link.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(pushed(link)).toEqual(["frame:wanted", "invalidate"]);
  });

  it("drops frames for a phone that fell behind, then names the runs to reload once it catches up", async () => {
    vi.useFakeTimers();
    const { link, remote } = session();
    link.receive({ t: "interest", runIds: ["a", "b"] });
    link.buffered = 3 * 1024 * 1024;
    remote.push(frame("a"), 100);
    remote.push(frame("b"), 100);
    remote.push({ type: "invalidate", keys: ["threads"] });
    await vi.advanceTimersByTimeAsync(50);
    expect(pushed(link)).toEqual(["invalidate"]);
    link.buffered = 0;
    remote.push(frame("a", 2), 100);
    await vi.advanceTimersByTimeAsync(50);
    expect(link.sent.at(-1)).toEqual({ t: "gap", runIds: ["a", "b"] });
    expect(link.sent.filter((message) => message.t === "gap")).toHaveLength(1);
    remote.push(frame("a", 3), 100);
    await vi.advanceTimersByTimeAsync(50);
    expect(pushed(link).at(-1)).toBe("frame:a");
  });

  it("answers after the pushes queued before the answer, without waiting for the batch", async () => {
    const { link, remote } = session();
    link.receive({ t: "interest", runIds: ["a"] });
    remote.push(frame("a"));
    link.receive({ t: "rpc", id: 1, method: "projects.list", params: {} });
    await vi.waitFor(() => expect(pushed(link)).toEqual(["frame:a", "rpc.result"]));
  });

  it("refuses a method a phone may not call without asking the core", async () => {
    const answer = vi.fn<Answer>(async (request): Promise<RpcReply> => ({ type: "rpc.result", id: request.id, result: null }));
    const { link } = session(answer);
    link.receive({ t: "rpc", id: 4, method: "workspace.configure", params: { entrypoint: "/" } });
    await vi.waitFor(() => expect(link.sent).toEqual([{ t: "rpc.error", id: 4, message: "This is not available from a phone." }]));
    expect(answer).not.toHaveBeenCalled();
  });

  it("answers a method about the phone itself for its own device, without asking the core", async () => {
    const answer = vi.fn<Answer>(async (request): Promise<RpcReply> => ({ type: "rpc.result", id: request.id, result: null }));
    const device = vi.fn<SessionDeps["device"]>(async () => "ready");
    const { link } = session(answer, undefined, device);
    const registration = { token: "ab".repeat(32), environment: "sandbox", alerts: "needs-you", sound: false } as const;
    link.receive({ t: "rpc", id: 5, method: "push.register", params: { registration } });
    await vi.waitFor(() => expect(link.sent).toEqual([{ t: "rpc.result", id: 5, result: "ready" }]));
    expect(device).toHaveBeenCalledWith("device", "push.register", { registration });
    expect(answer).not.toHaveBeenCalled();
  });

  it("refuses device params the schema rejects, and keeps the session", async () => {
    const device = vi.fn<SessionDeps["device"]>(async () => "ready");
    const { link } = session(undefined, undefined, device);
    const registration = { token: "ab".repeat(32), environment: "sandbox", alerts: "all", sound: true };
    const refused = [
      { registration: { ...registration, token: "AB".repeat(32) } },
      { registration: { ...registration, alerts: "off" } },
      { registration, deviceId: "another-phone" },
      { registration: { ...registration, deviceId: "another-phone" } },
      {},
    ];
    refused.forEach((params, index) => link.receive({ t: "rpc", id: index + 1, method: "push.register", params }));
    await vi.waitFor(() => expect(link.sent).toHaveLength(refused.length));
    for (const message of link.sent) expect(message).toMatchObject({ t: "rpc.error", message: expect.stringContaining("invalid params for push.register") });
    expect(device).not.toHaveBeenCalled();
    expect(link.closed).toBe(false);
  });

  it("streams at most four images at once and turns the rest away until one is sent", async () => {
    const { link } = session(undefined, async () => ({ ok: true, mime: "image/png", bytes: new Uint8Array(8) }));
    const ask = (id: number) => link.receive({ t: "asset", id, ref: { kind: "attachment", name: "dot.png" } });
    for (let id = 1; id <= 6; id++) ask(id);
    await vi.waitFor(() => expect(link.streams.map((stream) => stream.id)).toEqual([1, 2, 3, 4]));
    expect(link.sent.filter((message) => message.t === "asset.error").map((message) => message.id)).toEqual([5, 6]);
    link.streams[0]!.sent();
    await new Promise((resolve) => setTimeout(resolve, 0));
    ask(7);
    await vi.waitFor(() => expect(link.streams.map((stream) => stream.id)).toEqual([1, 2, 3, 4, 7]));
    expect(link.sent.at(-1)).toEqual({ t: "asset.bytes", id: 7, mime: "image/png", size: 8 });
  });

  it("ends a session that has heard nothing from the phone for 45 s", async () => {
    vi.useFakeTimers();
    const { link } = session();
    await vi.advanceTimersByTimeAsync(30_000);
    link.receive({ t: "ping", id: 1 });
    await vi.advanceTimersByTimeAsync(44_999);
    expect(link.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(link.closed).toBe(true);
  });

  it("says why before it closes", () => {
    const { link, remote } = session();
    remote.close("update");
    expect(link.sent).toEqual([{ t: "closing", reason: "update" }]);
    expect(link.closed && remote.closed).toBe(true);
  });
});
