import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { projects, settings, threads } from "@openorc/db";
import { git, commitAll } from "@openorc/git";
import type { RunSpec } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { inheritedProbe } from "./shell-environment.js";

it("retains a busy conversation's queued message across restart and uses its current settings exactly once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "durable-thread-queue-"));
  const dataDir = path.join(root, "data");
  const launched: RunSpec[] = [];
  const adapter = vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
    launched.push(spec);
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const handle = new RunHandle(spec.runId, {
      send: async () => {},
      interrupt() {},
      close() {
        handle.emit("exit", 0);
        finish(0);
      },
      done,
    });
    return handle;
  });
  let core: OpenOrc | undefined;
  try {
    await git(root, ["init", "-q", "-b", "main"]);
    await git(root, ["config", "user.name", "Fixture"]);
    await git(root, ["config", "user.email", "fixture@example.com"]);
    await writeFile(path.join(root, "README.md"), "# Queue\n");
    await commitAll(root, "Fixture");
    const open = () => OpenOrc.create({ dataDir, shellProbe: inheritedProbe(), transport: { push() {} } });
    core = await open();
    settings.set(core.db, "extraction.provider", "off");
    const project = await core.projects.import(root);
    const thread = threads.insert(core.db, { projectId: project.id, title: "Review", agent: "codex", model: "fixture", effort: "high", mode: "act", permissionMode: "review" });
    const busy = vi.spyOn(core.runs, "threadActivity").mockReturnValue("running");
    const input = { threadId: thread.id, text: "Fix these review comments", requestKey: "review:one,two" };
    const receipt = core.threads.queueFollowUp(input);
    expect(core.threads.queueFollowUp(input)).toEqual(receipt);
    expect(core.threads.get(thread.id)?.queued).toHaveLength(1);
    expect(launched).toEqual([]);
    // The destination's settings, not any comment model, determine delivery.
    threads.update(core.db, thread.id, { model: "changed-model", effort: "low" });
    await core.close();
    busy.mockRestore();
    core = undefined;
    core = await open();
    await vi.waitFor(() => expect(launched).toHaveLength(1));
    await vi.waitFor(() => expect(core!.threads.get(thread.id)?.queued).toEqual([]));
    expect(launched[0]).toMatchObject({ model: "changed-model", effort: "low", mode: "act", permissionMode: "review", prompt: input.text });
    expect(core.threads.queueFollowUp(input)).toEqual(receipt);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(launched).toHaveLength(1);
    expect(() => core!.threads.queueFollowUp({ ...input, text: "Other content" })).toThrow(/different content/);
  } finally {
    await core?.close();
    adapter.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("cancels queued workspace preparation before waiting for queue delivery at shutdown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "thread-queue-shutdown-"));
  let core: OpenOrc | undefined;
  const adapter = vi.spyOn(CodexAdapter.prototype, "start");
  try {
    await git(root, ["init", "-q", "-b", "main"]);
    await git(root, ["config", "user.name", "Fixture"]);
    await git(root, ["config", "user.email", "fixture@example.com"]);
    await writeFile(path.join(root, "README.md"), "# Queue\n");
    await commitAll(root, "Fixture");
    core = await OpenOrc.create({ dataDir: path.join(root, "data"), shellProbe: inheritedProbe(), transport: { push() {} } });
    settings.set(core.db, "extraction.provider", "off");
    const project = await core.projects.import(root);
    const marker = path.join(root, "setup-started");
    const script = path.join(root, "queue-setup.cjs");
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(() => {}, 1000);`);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    projects.updateSettings(core.db, project.id, { setupScript: `exec ${quote(process.execPath)} ${quote(script)}` });
    const thread = threads.insert(core.db, { projectId: project.id, title: "Setup", agent: "codex", model: "fixture", mode: "act", permissionMode: "review", workspaceMode: "worktree" });
    core.threads.queueFollowUp({ threadId: thread.id, text: "Continue after setup", requestKey: "setup" });
    await vi.waitFor(() => access(marker), { timeout: 5000 });
    await core.close();
    core = undefined;
    expect(adapter).not.toHaveBeenCalled();
  } finally {
    await core?.close();
    adapter.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
