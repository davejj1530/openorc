import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { projects, threads } from "@openorc/db";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { commitAll, git } from "@openorc/git";
import type { RunSpec } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";

let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

it("runs every conversation in a pull request's copy as an unvetted checkout, in any mode", async () => {
  root = await mkdtemp(join(tmpdir(), "openorc-review-runs-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(join(root, "README.md"), "Fixture\n");
  const head = await commitAll(root, "init");
  const specs: RunSpec[] = [];
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => (finish = resolve));
    const handle = new RunHandle(spec.runId, { send: async () => {}, interrupt() {}, close: () => finish(0), done });
    specs.push(spec);
    setTimeout(() => {
      handle.emit("event", { type: "session.started", runId: spec.runId, ts: Date.now(), agent: "codex", externalSessionId: spec.runId, model: "fixture" });
      handle.emit("event", { type: "turn.completed", runId: spec.runId, ts: Date.now(), turnId: "turn", status: "success", durationMs: 1 });
    }, 0);
    return handle;
  });
  const core = await OpenOrc.create({ dataDir: join(root, "data"), ephemeral: true, transport: { push() {} } });
  vi.spyOn(core.memory, "onRunFinished").mockImplementation(() => {});
  vi.spyOn(core.textGeneration, "title").mockResolvedValue(null);
  try {
    const project = projects.insert(core.db, { name: "Site", rootPath: root, gitRemote: null, defaultBranch: "main", settings: {} });
    const input = { agent: "codex" as const, model: "fixture", effort: undefined, mode: "act" as const, permissionMode: "autonomous" as const, attachments: undefined };
    const { thread: own } = await core.threads.start({ ...input, prompt: "Hello", projectId: project.id, title: undefined, workspaceMode: "current" });
    await vi.waitFor(() => expect(core.threads.get(own.id)?.activity).toBe("idle"));
    expect(specs[0]!.untrustedCheckout).toBeUndefined();

    // A pull request's copy: a worktree on no branch. Its fork shares it, and neither is linked to the review.
    const copy = join(root, "..", `${basename(root)}-pr-7`);
    await git(root, ["worktree", "add", "-q", "--detach", copy, head]);
    const review = threads.insert(core.db, { projectId: project.id, title: "Review #7", agent: "codex", model: "fixture", mode: "plan", permissionMode: "review", workspaceMode: "worktree" });
    threads.update(core.db, review.id, { worktreePath: copy, baseSha: head });
    const fork = core.threads.fork(review.id);
    for (const thread of [review, fork]) {
      await core.threads.continueThread(thread.id, { ...input, prompt: "Fix it yourself" });
      await vi.waitFor(() => expect(core.threads.get(thread.id)?.activity).toBe("idle"));
      expect(specs.at(-1)).toMatchObject({ cwd: await realpath(copy), mode: "act", permissionMode: "autonomous", untrustedCheckout: true });
    }
    await rm(copy, { recursive: true, force: true });
  } finally {
    await core.close();
  }
});
