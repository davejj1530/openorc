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
  preview: SessionDeps["preview"] = null,
) {
  const link = new FakeLink();
  const remote = new RemoteSession("device", link as unknown as MacSession, {
    answer,
    guard: { attachmentsDir: "/data/attachments", thread: (id) => (id === "gone" ? null : { team: false }) },
    roots: () => ({ home: "/Users/me", dataDir: "/Users/me/.openorc", projects: [] }),
    readAsset,
    device,
    preview,
    watchable: (id) => id !== "gone",
  });
  return { link, remote };
}

function casters() {
  return {
    watch: vi.fn(async (_session: unknown, { threadId }: { threadId: string }) => ({
      open: true as const,
      pane: "p",
      address: `http://127.0.0.1:47831/${threadId}`,
      title: "QA",
      phase: "live" as const,
      error: null,
      frame: null,
    })),
    unwatch: vi.fn(),
    frame: vi.fn((_session: unknown, threadId: string, seq: number) => (threadId === "t1" && seq === 1 ? new Uint8Array([0xff, 0xd8, 0xff]) : null)),
    input: vi.fn(async () => ({ focus: null })),
  };
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

  it("tells the core each request came from this phone", async () => {
    const answer = vi.fn<Answer>(async (request): Promise<RpcReply> => ({ type: "rpc.result", id: request.id, result: null }));
    const { link } = session(answer);
    link.receive({ t: "rpc", id: 6, method: "review.pushThread", params: { threadId: "t" } });
    await vi.waitFor(() => expect(link.sent).toEqual([{ t: "rpc.result", id: 6, result: null }]));
    expect(answer).toHaveBeenCalledWith({ type: "rpc", id: 6, method: "review.pushThread", params: { threadId: "t" } }, { kind: "phone", deviceId: "device" });
  });

  it("redacts every error a phone hears, a hook's output or a thrown one", async () => {
    const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12";
    const answer: Answer = async (request) => {
      if (request.id === 8) throw new Error(`git push failed in /Users/me/repo: ${token}`);
      return { type: "rpc.error", id: request.id, message: `git commit failed: pre-commit printed ${token}` };
    };
    const { link } = session(answer);
    link.receive({ t: "rpc", id: 7, method: "review.commitThread", params: { threadId: "t", message: "x" } });
    link.receive({ t: "rpc", id: 8, method: "review.pushThread", params: { threadId: "t" } });
    await vi.waitFor(() => expect(link.sent).toHaveLength(2));
    for (const message of link.sent) {
      expect(message).toMatchObject({ t: "rpc.error", message: expect.stringContaining("[redacted:github-token]") });
      expect(JSON.stringify(message)).not.toContain(token);
    }
  });

  it("leaves the Mac's folders out of a Git error", async () => {
    const answer: Answer = async (request) => ({ type: "rpc.error", id: request.id, message: "git commit -q -F - failed (1) in /Users/me/.openorc/worktrees/a1b2: nothing to commit" });
    const { link } = session(answer);
    link.receive({ t: "rpc", id: 10, method: "review.commitThread", params: { threadId: "t", message: "x" } });
    await vi.waitFor(() => expect(link.sent).toEqual([{ t: "rpc.error", id: 10, message: "git commit -q -F - failed (1): nothing to commit" }]));
  });

  it("strips the Mac's known folders from a result's reasons, as from its errors", async () => {
    const blocked = "git symbolic-ref failed (128) in /Users/me/.openorc/worktrees/site-a1/fix-b2: fatal: ref HEAD is not a symbolic ref, see /Users/me/.openorc/worktrees/site-a1/fix-b2/.git";
    const answer: Answer = async (request) => ({ type: "rpc.result", id: request.id, result: { branch: null, blocked, published: false, unpushedCount: 0, unpushed: [], busy: false } });
    const { link } = session(answer);
    link.receive({ t: "rpc", id: 11, method: "git.threadPushState", params: { threadId: "t" } });
    await vi.waitFor(() => expect(link.sent).toHaveLength(1));
    expect(link.sent[0]).toMatchObject({ t: "rpc.result", result: { blocked: "git symbolic-ref failed (128): fatal: ref HEAD is not a symbolic ref, see .git", busy: false } });
  });

  it("shapes a result by its method before the phone hears it", async () => {
    const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12";
    const diff = { path: "a.ts", oldPath: null, status: "modified", body: { kind: "text", insertions: 1, deletions: 0 }, patch: `@@ -0,0 +1 @@\n+${token}\n`, cut: null };
    const { link } = session(async (request) => ({ type: "rpc.result", id: request.id, result: diff }));
    link.receive({ t: "rpc", id: 9, method: "review.threadFileDiff", params: { threadId: "t", path: "a.ts" } });
    await vi.waitFor(() => expect(link.sent).toHaveLength(1));
    expect(link.sent[0]).toMatchObject({ t: "rpc.result", id: 9, result: { path: "a.ts", patch: "@@ -0,0 +1 @@\n+[redacted:github-token]\n" } });
  });

  it("answers its own watch of a Preview, never the core, and ends it on unwatch and on close", async () => {
    const answer = vi.fn<Answer>(async (request) => ({ type: "rpc.result", id: request.id, result: null }));
    const preview = casters();
    const { link, remote } = session(answer, undefined, undefined, preview);
    link.receive({ t: "rpc", id: 1, method: "preview.watch", params: { threadId: "t1", width: 786, pace: "lan" } });
    await vi.waitFor(() => expect(link.sent).toHaveLength(1));
    expect(link.sent[0]).toEqual({ t: "rpc.result", id: 1, result: expect.objectContaining({ open: true, address: "http://127.0.0.1:47831/t1" }) });
    expect(preview.watch).toHaveBeenCalledWith(remote, { threadId: "t1", width: 786, pace: "lan" });
    link.receive({ t: "rpc", id: 2, method: "preview.unwatch", params: {} });
    await vi.waitFor(() => expect(link.sent).toHaveLength(2));
    expect(link.sent[1]).toEqual({ t: "rpc.result", id: 2, result: null });
    expect(preview.unwatch).toHaveBeenCalledWith(remote);
    expect(answer).not.toHaveBeenCalled();
    link.close();
    expect(preview.unwatch).toHaveBeenCalledTimes(2);
  });

  it("refuses a watch of a thread that is gone, or with params outside its schema", async () => {
    const preview = casters();
    const { link } = session(undefined, undefined, undefined, preview);
    link.receive({ t: "rpc", id: 1, method: "preview.watch", params: { threadId: "gone", width: 786, pace: "lan" } });
    link.receive({ t: "rpc", id: 2, method: "preview.watch", params: { threadId: "task:t1", width: 786, pace: "lan" } });
    link.receive({ t: "rpc", id: 3, method: "preview.watch", params: { threadId: "t1", width: 786, pace: "lan", command: { action: "click", ref: "e1" } } });
    await vi.waitFor(() => expect(link.sent).toHaveLength(3));
    expect(link.sent[0]).toEqual({ t: "rpc.error", id: 1, message: "This thread is gone." });
    for (const message of link.sent.slice(1)) expect(message).toMatchObject({ t: "rpc.error", message: expect.stringContaining("invalid params for preview.watch") });
    expect(preview.watch).not.toHaveBeenCalled();
  });

  it("reads a watch as closed on a Mac without a Preview host", async () => {
    const { link } = session();
    link.receive({ t: "rpc", id: 1, method: "preview.watch", params: { threadId: "t1", width: 786, pace: "lan" } });
    await vi.waitFor(() => expect(link.sent).toEqual([{ t: "rpc.result", id: 1, result: { open: false } }]));
  });

  it("answers an input for its own session through its casters, never the core", async () => {
    const answer = vi.fn<Answer>(async (request) => ({ type: "rpc.result", id: request.id, result: null }));
    const preview = casters();
    const { link, remote } = session(answer, undefined, undefined, preview);
    const params = { threadId: "t1", pane: "0123456789ab", frame: { width: 786, height: 566 }, input: { kind: "tap", x: 10.5, y: 20, count: 1 } };
    link.receive({ t: "rpc", id: 1, method: "preview.input", params });
    await vi.waitFor(() => expect(link.sent).toHaveLength(1));
    expect(link.sent[0]).toEqual({ t: "rpc.result", id: 1, result: { focus: null } });
    expect(preview.input).toHaveBeenCalledWith(remote, params);
    expect(answer).not.toHaveBeenCalled();
  });

  it("refuses an input outside its schema, and any input on a Mac without a Preview host", async () => {
    const preview = casters();
    const { link } = session(undefined, undefined, undefined, preview);
    const base = { threadId: "t1", pane: "0123456789ab", frame: { width: 786, height: 566 } };
    const invalid = [
      { ...base, input: { kind: "tap", x: 10, y: 20, count: 1 }, command: { action: "click", ref: "e1" } },
      { ...base, input: { kind: "tap", x: 10, y: 20, count: 1 }, surface: "thread:t1" },
      { ...base, pane: "thread:t1", input: { kind: "tap", x: 10, y: 20, count: 1 } },
      { ...base, input: { kind: "navigate", url: "https://example.com" } },
      { ...base, input: { kind: "tap", x: -1, y: 20, count: 1 } },
      { ...base, input: { kind: "key", key: "Escape", count: 1 } },
      { ...base, input: { kind: "text", text: "x".repeat(1001) } },
      { ...base, input: { kind: "tap", x: 10, y: 20, count: 1, button: "right" } },
      { ...base, threadId: "task:t1", input: { kind: "tap", x: 10, y: 20, count: 1 } },
    ];
    invalid.forEach((params, index) => link.receive({ t: "rpc", id: index + 1, method: "preview.input", params }));
    await vi.waitFor(() => expect(link.sent).toHaveLength(invalid.length));
    for (const message of link.sent) expect(message).toMatchObject({ t: "rpc.error", message: expect.stringContaining("invalid params for preview.input") });
    expect(preview.input).not.toHaveBeenCalled();
    const bare = session();
    bare.link.receive({ t: "rpc", id: 1, method: "preview.input", params: { ...base, input: { kind: "text", text: "hi" } } });
    await vi.waitFor(() => expect(bare.link.sent).toEqual([{ t: "rpc.error", id: 1, message: "This page is not being watched." }]));
  });

  it("serves a watched frame as JPEG bytes from the caster, and refuses any other", async () => {
    const readAsset = vi.fn<SessionDeps["readAsset"]>(async () => ({ ok: true, mime: "image/png", bytes: new Uint8Array(8) }));
    const preview = casters();
    const { link, remote } = session(undefined, readAsset, undefined, preview);
    link.receive({ t: "asset", id: 1, ref: { kind: "preview", threadId: "t1", seq: 1 } });
    link.receive({ t: "asset", id: 2, ref: { kind: "preview", threadId: "t2", seq: 1 } });
    await vi.waitFor(() => expect(link.sent).toHaveLength(2));
    expect(link.sent).toEqual([
      { t: "asset.bytes", id: 1, mime: "image/jpeg", size: 3 },
      { t: "asset.error", id: 2, message: "This page is not being watched." },
    ]);
    expect(link.streams.map((stream) => stream.id)).toEqual([1]);
    expect(preview.frame).toHaveBeenCalledWith(remote, "t1", 1);
    expect(readAsset).not.toHaveBeenCalled();
  });

  it("says why before it closes", () => {
    const { link, remote } = session();
    remote.close("update");
    expect(link.sent).toEqual([{ t: "closing", reason: "update" }]);
    expect(link.closed && remote.closed).toBe(true);
  });
});
