import { describe, expect, it } from "vitest";
import { REMOTE_ATTACHMENT_BYTES } from "@openorc/protocol";
import { admitRemoteRequest, remotePush } from "./policy.js";

const context = { attachmentsDir: "/data/attachments" };
const image = "/data/attachments/0b9f2c1e-7d1a-4b55-9a0e-3f2b8c6d4e10.png";

describe("phone policy", () => {
  it("admits what the phone's own screens send", () => {
    expect(admitRemoteRequest("threads.update", { id: "t", patch: { seen: true, model: "gpt", permissionMode: "trusted" } }, context)).toEqual({ ok: true });
    expect(admitRemoteRequest("runs.send", { runId: "r", text: "look", attachments: [image] }, context)).toEqual({ ok: true });
    expect(admitRemoteRequest("attachments.save", { name: "a.png", mime: "image/png", dataBase64: "AAAA" }, context)).toEqual({ ok: true });
  });

  it("leaves params a method rejects for the core to word", () => {
    expect(admitRemoteRequest("runs.send", { runId: 7 }, context)).toEqual({ ok: true });
  });

  it.each([
    ["an attachment beside the folder", "runs.send", { runId: "r", text: "x", attachments: ["/data/attachments/../openorc.sqlite"] }],
    ["an attachment in a folder below it", "threads.queue", { id: "t", text: "x", attachments: ["/data/attachments/nested/a.png"] }],
    ["a stored file that is not an image", "runs.start", { agent: "codex", mode: "act", permissionMode: "trusted", prompt: "x", attachments: ["/data/attachments/0b9f-notes.txt"] }],
    ["a thread change made on the Mac", "threads.update", { id: "t", patch: { archived: true } }],
    ["a change through a saved task", "threads.update", { id: "t", taskId: "task", patch: { seen: true } }],
    ["an image over the phone limit", "attachments.save", { name: "a.png", mime: "image/png", dataBase64: "A".repeat(Math.ceil(REMOTE_ATTACHMENT_BYTES / 3) * 4 + 4) }],
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
