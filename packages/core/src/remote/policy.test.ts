import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceRpcParams, isRemoteMethod, REMOTE_ATTACHMENT_BYTES, remoteRpcParams, rpcParams } from "@openorc/protocol";
import { admitRemoteRequest, remotePush } from "./policy.js";

const context = { attachmentsDir: "/data/attachments" };
const image = "/data/attachments/0b9f2c1e-7d1a-4b55-9a0e-3f2b8c6d4e10.png";

const now = Date.UTC(2026, 9, 24, 12);
const hour = 3_600_000;

describe("phone policy", () => {
  beforeEach(() => vi.useFakeTimers({ now }));
  afterEach(() => vi.useRealTimers());

  it("admits what the phone's own screens send", () => {
    expect(admitRemoteRequest("threads.update", { id: "t", patch: { seen: true, model: "gpt", permissionMode: "trusted" } }, context)).toEqual({ ok: true });
    expect(admitRemoteRequest("runs.send", { runId: "r", text: "look", attachments: [image] }, context)).toEqual({ ok: true });
    expect(admitRemoteRequest("attachments.save", { name: "a.png", mime: "image/png", dataBase64: "AAAA" }, context)).toEqual({ ok: true });
    expect(admitRemoteRequest("agents.availability", {}, context)).toEqual({ ok: true });
    expect(admitRemoteRequest("projects.git", { id: "p" }, context)).toEqual({ ok: true });
    expect(admitRemoteRequest("providers.limits", {}, context)).toEqual({ ok: true });
  });

  it("keeps phone access and its push key out of a phone's reach", () => {
    expect(Object.keys(remoteRpcParams)).toEqual(expect.arrayContaining(["remote.push.setKey", "remote.push.removeKey", "remote.push.test"]));
    for (const method of Object.keys(remoteRpcParams)) expect(isRemoteMethod(method), method).toBe(false);
  });

  it("keeps methods about the phone itself apart from every core method", () => {
    for (const method of Object.keys(deviceRpcParams)) expect(Object.hasOwn(rpcParams, method), method).toBe(false);
  });

  it("keeps the Mac's full usage reports and account list off the phone", () => {
    for (const [method, params] of [
      ["providers.usage", { provider: "codex" }],
      ["claude.accounts.list", { refresh: true }],
    ] as const) {
      expect(admitRemoteRequest(method, params, context)).toEqual({ ok: false, message: "This is not available from a phone." });
    }
  });

  it("lets the phone organize threads: pin, archive, snooze, rename and mark read or unread", () => {
    for (const patch of [
      { pinned: true },
      { archived: false },
      { snoozedUntil: now + hour },
      { snoozedUntil: now + 300 * 24 * hour },
      { snoozedUntil: null },
      { title: "Pairing review" },
      { title: "🦊".repeat(200) },
      { seen: false },
    ]) {
      expect(admitRemoteRequest("threads.update", { id: "t", patch }, context)).toEqual({ ok: true });
    }
  });

  it("leaves params a method rejects for the core to word, a snooze no clock can hold among them", () => {
    expect(admitRemoteRequest("runs.send", { runId: 7 }, context)).toEqual({ ok: true });
    expect(admitRemoteRequest("threads.update", { id: "t", patch: { snoozedUntil: 2 ** 62 } }, context)).toEqual({ ok: true });
  });

  it.each([
    ["an attachment beside the folder", "runs.send", { runId: "r", text: "x", attachments: ["/data/attachments/../openorc.sqlite"] }],
    ["an attachment in a folder below it", "threads.queue", { id: "t", text: "x", attachments: ["/data/attachments/nested/a.png"] }],
    ["a stored file that is not an image", "runs.start", { agent: "codex", mode: "act", permissionMode: "trusted", prompt: "x", attachments: ["/data/attachments/0b9f-notes.txt"] }],
    ["a draft, which stays on the device that wrote it", "threads.update", { id: "t", patch: { draft: "half a thought" } }],
    ["a pull request link", "threads.update", { id: "t", patch: { pinned: true, prUrl: "https://github.com/me/repo/pull/1" } }],
    ["marking a thread done", "threads.update", { id: "t", patch: { done: true } }],
    ["a change through a saved task", "threads.update", { id: "t", taskId: "task", patch: { seen: true } }],
    ["an image over the phone limit", "attachments.save", { name: "a.png", mime: "image/png", dataBase64: "A".repeat(Math.ceil(REMOTE_ATTACHMENT_BYTES / 3) * 4 + 4) }],
    ["a snooze that already passed", "threads.update", { id: "t", patch: { snoozedUntil: now - hour } }],
    ["a snooze more than a year away", "threads.update", { id: "t", patch: { snoozedUntil: now + 400 * 24 * hour } }],
    ["an empty title", "threads.update", { id: "t", patch: { title: "   " } }],
    ["a title over 200 characters", "threads.update", { id: "t", patch: { title: "x".repeat(201) } }],
    ["a title over 200 characters past the basic plane", "threads.update", { id: "t", patch: { title: "🦊".repeat(201) } }],
    ["a title with a line break", "threads.update", { id: "t", patch: { title: "Review\nINFO forged log line" } }],
    ["a title with a line separator", "threads.update", { id: "t", patch: { title: "Review\u2028INFO forged log line" } }],
    ["a title with a paragraph separator", "threads.update", { id: "t", patch: { title: "Review\u2029INFO forged log line" } }],
    ["a title with a left-to-right isolate", "threads.update", { id: "t", patch: { title: "invoice\u2066fdp.exe" } }],
    ["a title with a right-to-left isolate", "threads.update", { id: "t", patch: { title: "invoice\u2067fdp.exe" } }],
    ["a title with a first-strong isolate", "threads.update", { id: "t", patch: { title: "invoice\u2068fdp.exe" } }],
    ["a title with an isolate's end", "threads.update", { id: "t", patch: { title: "invoice\u2069fdp.exe" } }],
    ["a title with a terminal escape", "threads.update", { id: "t", patch: { title: "\u001b[31mred" } }],
    ["a title with a right-to-left override", "threads.update", { id: "t", patch: { title: "invoice\u202Efdp.exe" } }],
    ["a new thread's title with a NUL", "threads.start", { projectId: "p", agent: "codex", mode: "act", permissionMode: "trusted", prompt: "x", title: "a\u0000b" }],
    ["deleting a thread", "threads.delete", { id: "t" }],
    ["forking a thread", "threads.fork", { id: "t" }],
  ])("refuses %s", (_case, method, params) => {
    expect(admitRemoteRequest(method, params, context)).toMatchObject({ ok: false });
  });

  it("tells a phone nothing about the Mac's processes, logs or benchmarks", () => {
    expect(remotePush({ type: "ready", pid: 42, mcpPort: 5000 })).toEqual({ type: "ready" });
    expect(remotePush({ type: "startup", message: "Tidying up" })).toBeNull();
    expect(remotePush({ type: "log", level: "error", message: "/Users/someone/secret" })).toBeNull();
    expect(remotePush({ type: "bench.done", eventsSent: 1, framesSent: 1, durationMs: 1 })).toBeNull();
    expect(remotePush({ type: "invalidate", keys: ["threads"] })).toEqual({ type: "invalidate", keys: ["threads"] });
    expect(
      remotePush({ type: "notify", kind: "approval", threadId: "t", taskId: null, title: "Codex", body: "wants to run export GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12" }),
    ).toMatchObject({
      body: expect.stringContaining("[redacted:"),
    });
  });
});
