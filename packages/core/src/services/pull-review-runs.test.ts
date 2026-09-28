import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { projects, pullReviews } from "@openorc/db";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { commitAll, git } from "@openorc/git";
import type { RunSpec } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";

let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

it("runs a pull request's review conversation as an unvetted checkout, in any mode", async () => {
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
    const { thread } = await core.threads.start({ ...input, prompt: "Hello", projectId: project.id, title: undefined, workspaceMode: "current" });
    await vi.waitFor(() => expect(core.threads.get(thread.id)?.activity).toBe("idle"));
    expect(specs[0]!.untrustedCheckout).toBeUndefined();

    pullReviews.open(core.db, { projectId: project.id, number: 7 }, head);
    pullReviews.update(core.db, { projectId: project.id, number: 7 }, { threadId: thread.id });
    await core.threads.continueThread(thread.id, { ...input, prompt: "Fix it yourself" });
    await vi.waitFor(() => expect(specs).toHaveLength(2));
    expect(specs[1]).toMatchObject({ mode: "act", permissionMode: "autonomous", untrustedCheckout: true });
  } finally {
    await core.close();
  }
});
