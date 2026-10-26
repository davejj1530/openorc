import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceRpcParams, isRemoteMethod, REMOTE_ATTACHMENT_BYTES, REMOTE_METHODS, remoteRpcParams, rpcParams, type FileDiff } from "@openorc/protocol";
import { remoteError, type MacRoots } from "./phone-words.js";
import { admitRemoteRequest, remotePush, remoteReplies, remoteReply, type GuardContext } from "./policy.js";

/** Threads the guards can see: "team" belongs to a team, "solo" does not, anything else is unknown. */
const seen: Record<string, { team: boolean }> = { team: { team: true }, solo: { team: false } };
const context: GuardContext = { attachmentsDir: "/data/attachments", thread: (id) => seen[id] ?? null };
const TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12";
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

  it("admits the reads a phone's Changes screen makes, team threads included", () => {
    for (const threadId of ["solo", "team"]) {
      for (const [method, params] of [
        ["review.threadChanges", { threadId, comparison: "head" }],
        ["review.threadFileDiff", { threadId, path: "src/index.ts" }],
        ["git.threadLog", { threadId, limit: 10 }],
        ["git.threadPushState", { threadId }],
        ["review.threadPrTemplate", { threadId }],
      ] as const) {
        expect(admitRemoteRequest(method, params, context), `${method} on ${threadId}`).toEqual({ ok: true });
      }
    }
    expect(admitRemoteRequest("pulls.branches", { projectId: "p", prefer: "main" }, context)).toEqual({ ok: true });
    expect(admitRemoteRequest("system.gh", {}, context)).toEqual({ ok: true });
  });

  it("admits commit, push and a pull request through the desktop's own methods", () => {
    expect(admitRemoteRequest("review.commitThread", { threadId: "solo", message: "Fix the list\n\n- keeps\tthe order" }, context)).toEqual({ ok: true });
    expect(admitRemoteRequest("review.pushThread", { threadId: "solo" }, context)).toEqual({ ok: true });
    expect(admitRemoteRequest("review.createThreadPr", { threadId: "solo", title: "Fix the list 🦊", body: "What this changes\n\nand how to check it", base: "main" }, context)).toEqual({ ok: true });
    expect(admitRemoteRequest("review.commitThread", { threadId: "solo", message: "x".repeat(10_000) }, context)).toEqual({ ok: true });
    expect(admitRemoteRequest("review.createThreadPr", { threadId: "solo", title: "t".repeat(256), body: "b".repeat(65_536), base: "main" }, context)).toEqual({ ok: true });
  });

  it("leaves a team's publishing to the Mac", () => {
    for (const [method, params] of [
      ["review.commitThread", { threadId: "team", message: "Team work" }],
      ["review.pushThread", { threadId: "team" }],
      ["review.createThreadPr", { threadId: "team", title: "Team work", body: "", base: "main" }],
    ] as const) {
      expect(admitRemoteRequest(method, params, context), method).toEqual({ ok: false, message: "Publish a team's work on your Mac." });
    }
  });

  it.each([
    ["a commit message over 10,000 characters", "review.commitThread", { threadId: "solo", message: "x".repeat(10_001) }],
    ["a commit message with a NUL", "review.commitThread", { threadId: "solo", message: "Fix\u0000" }],
    ["a commit message with a terminal escape", "review.commitThread", { threadId: "solo", message: "\u001b[31mred" }],
    ["a commit message with a carriage return", "review.commitThread", { threadId: "solo", message: "one\rtwo" }],
    ["a commit message with a right-to-left override", "review.commitThread", { threadId: "solo", message: "invoice\u202Efdp.exe" }],
    ["a commit message with an isolate", "review.commitThread", { threadId: "solo", message: "invoice\u2066fdp.exe" }],
    ["a pull request title over 256 characters", "review.createThreadPr", { threadId: "solo", title: "t".repeat(257), body: "", base: "main" }],
    ["a pull request title with a line break", "review.createThreadPr", { threadId: "solo", title: "Fix\nINFO forged", body: "", base: "main" }],
    ["a blank pull request title", "review.createThreadPr", { threadId: "solo", title: "   ", body: "", base: "main" }],
    ["a pull request title with a bidi override", "review.createThreadPr", { threadId: "solo", title: "Fix\u202Eexe", body: "", base: "main" }],
    ["a pull request body over 65,536 characters", "review.createThreadPr", { threadId: "solo", title: "Fix", body: "b".repeat(65_537), base: "main" }],
  ])("refuses %s", (_case, method, params) => {
    expect(admitRemoteRequest(method, params, context)).toMatchObject({ ok: false });
  });

  it("keeps the whole patch, the Mac's paths, team projections, and project and task Git off the phone", () => {
    for (const [method, params] of [
      ["review.threadDiff", { threadId: "solo" }],
      ["system.info", {}],
      ["orchestration.runtime", { threadId: "solo" }],
      ["review.projectDiff", { projectId: "p" }],
      ["review.commitProject", { projectId: "p", message: "x" }],
      ["review.pushProject", { projectId: "p" }],
      ["git.projectLog", { projectId: "p" }],
      ["git.projectPushState", { projectId: "p" }],
      ["review.diff", { taskId: "t" }],
      ["review.commit", { taskId: "t", message: "x" }],
      ["review.push", { taskId: "t" }],
      ["review.createPr", { taskId: "t", title: "x", body: "", base: "main" }],
      ["git.log", { taskId: "t" }],
    ] as const) {
      expect(admitRemoteRequest(method, params, context), method).toEqual({ ok: false, message: "This is not available from a phone." });
    }
  });

  it("shapes every reply a phone hears, redacting file text, commit subjects and the pull request template", () => {
    expect(Object.keys(remoteReplies).sort()).toEqual([...REMOTE_METHODS].sort());
    const diff: FileDiff = {
      path: "config.ts",
      oldPath: null,
      status: "modified",
      body: { kind: "text", insertions: 1, deletions: 0 },
      patch: `@@ -0,0 +1 @@\n+const token = "${TOKEN}";\n`,
      cut: null,
    };
    const context = { words: (message: string) => `shaped: ${message}`, roots: () => ({ home: "/Users/me", dataDir: "/Users/me/.openorc", projects: [] }) };
    const shaped = remoteReply("review.threadFileDiff", diff, context);
    expect(shaped.patch).toContain("[redacted:github-token]");
    expect(shaped.patch).not.toContain(TOKEN);
    expect(shaped.path).toBe("config.ts");
    expect(remoteReply("git.threadLog", [{ sha: "a".repeat(40), author: "Me", at: 1, subject: `Rotate ${TOKEN}` }], context)[0]!.subject).toContain("[redacted:github-token]");
    expect(remoteReply("review.threadPrTemplate", { body: `Token: ${TOKEN}` }, context).body).toContain("[redacted:github-token]");
    const push = { branch: "feat/x", blocked: null, published: true, unpushedCount: 0, unpushed: [], busy: true };
    expect(remoteReply("git.threadPushState", push, context)).toBe(push);
    // Why Push is blocked can be a GitError naming the Mac's folders.
    expect(remoteReply("git.threadPushState", { ...push, blocked: "git symbolic-ref failed (128) in /Users/me/dev/site: fatal: bad HEAD" }, context)).toEqual({
      ...push,
      blocked: "shaped: git symbolic-ref failed (128) in /Users/me/dev/site: fatal: bad HEAD",
    });
    expect(remoteReply("review.commitThread", { sha: "b".repeat(40) }, context)).toEqual({ sha: "b".repeat(40) });
  });

  it("keeps the Mac's paths and tokens out of every error a phone hears", () => {
    const roots: MacRoots = { home: "/Users/me", dataDir: "/Users/me/Library/Application Support/OpenOrc", projects: ["/Users/me/dev/site", "/var/folders/x/T/qa/repo"] };
    const worktree = "/Users/me/Library/Application Support/OpenOrc/worktrees/site-a1b2c3/thread-fix-d4e5f6";
    expect(remoteError(`git commit -q -F - failed (1) in ${worktree}: lint failed: ${TOKEN} is checked in`, roots)).toBe(
      "git commit -q -F - failed (1): lint failed: [redacted:github-token] is checked in",
    );
    expect(remoteError("Workspace /Users/me/dev/site is in use by run r1. Finish or stop that operation before committing.", roots)).toBe(
      "Workspace site is in use by run r1. Finish or stop that operation before committing.",
    );
    expect(remoteError("/Users/me/dev/site/src/a.ts:3:1: no-console\n'/private/var/folders/x/T/qa/repo/b.ts' failed", roots)).toBe("src/a.ts:3:1: no-console\n'b.ts' failed");
    // Spaces, file URLs and paths after a bracket: the known roots come off by prefix, leaving repository paths.
    expect(remoteError(`error: ${worktree}/src/My Notes.md: not valid`, roots)).toBe("error: src/My Notes.md: not valid");
    expect(remoteError(`see file://${encodeURI(worktree)}/docs/a.md and <${worktree}/b.ts>, [${worktree}/c.ts]`, roots)).toBe("see docs/a.md and <b.ts>, [c.ts]");
    expect(remoteError("Workspace /Users/me/Library/Application Support/OpenOrc/worktrees/site-a1b2c3/thread-fix-d4e5f6 is in use.", roots)).toBe("Workspace thread-fix-d4e5f6 is in use.");
    expect(remoteError("could not read /Users/me/Library/Application Support/OpenOrc/settings.json", roots)).toBe("could not read settings.json");
    expect(remoteError("hook at /Users/me/.config/hooks/lint failed in /Users/me", roots)).toBe("hook at .config/hooks/lint failed in ~");
    // A folder beside a project's is not inside it.
    expect(remoteError("/Users/me/dev/site-old/a.ts", roots)).toBe("dev/site-old/a.ts");
    expect(remoteError("/opt/homebrew/bin/gh: not found", roots)).toBe("gh: not found");
    for (const kept of [
      "origin has newer commits on feat/x. Pull them in first, then push again.",
      "gh pr create failed: https://github.com/fake/site/pull/1 exists",
      "main isn't a branch on GitHub.",
    ]) {
      expect(remoteError(kept, roots)).toBe(kept);
    }
  });
});
