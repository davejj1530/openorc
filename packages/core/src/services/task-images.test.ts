import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ClaudeAdapter, CodexAdapter, RunHandle } from "@openorc/agents";
import { threads } from "@openorc/db";
import { git, commitAll } from "@openorc/git";
import type { CorePush, RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import { OpenOrc } from "../openorc";

let dir: string;
let core: OpenOrc;
let projectId: string;
let id = 0;
const messages: CorePush[] = [];
async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
  const requestId = ++id;
  await core.handle({ type: "rpc", id: requestId, method, params });
  const response = messages.find((message) => (message.type === "rpc.result" || message.type === "rpc.error") && message.id === requestId);
  if (!response || response.type === "rpc.error") throw new Error(response?.message ?? "Missing result");
  return (response as { result: RpcResults[M] }).result;
}
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "task-image-launch-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await writeFile(path.join(dir, "README.md"), "Task image fixture");
  await commitAll(dir, "Initial");
  core = await OpenOrc.create({ dataDir: path.join(dir, "data"), ephemeral: true, transport: { push: (message) => messages.push(message) } });
  projectId = (await call("projects.import", { rootPath: dir })).id;
});
afterAll(async () => {
  await core?.close();
  await rm(dir, { force: true, recursive: true });
});

it.each([
  ["codex", "tasks.start"],
  ["claude", "tasks.start"],
  ["codex", "runs.start"],
  ["claude", "runs.start"],
] as const)("hands task images to %s through %s", async (agent, method) => {
  const image = await call("attachments.save", {
    name: "reference.png",
    mime: "image/png",
    dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=",
  });
  const parent = threads.insert(core.db, { projectId, title: "Parent", agent, model: null, mode: "act", permissionMode: "trusted" });
  const task = await call("tasks.create", { projectId, threadId: parent.id, title: "Implement reference", spec: `Keep this text.\n\n![Reference](${image.url})`, useWorktree: false });
  let handle: RunHandle | undefined;
  const adapter = vi.spyOn(agent === "codex" ? CodexAdapter.prototype : ClaudeAdapter.prototype, "start").mockImplementation((spec, _launch) => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      finish = resolve;
    });
    handle = new RunHandle(spec.runId, {
      send: async () => {},
      interrupt() {},
      close() {
        handle!.emit("exit", 0);
        finish(0);
      },
      done,
    });
    return handle;
  });
  const models = vi.spyOn(core.runs, "models").mockResolvedValue([]);
  try {
    if (method === "tasks.start") await call("tasks.start", { taskId: task.id, workspaceMode: "current" });
    else await call("runs.start", { taskId: task.id, agent, mode: "act", permissionMode: "trusted", prompt: "Start", attachments: [image.path, "/tmp/extra.png"] });
    const spec = adapter.mock.calls[0]![0];
    // Only the user's own composer attachments ride on the message; task images are listed in the brief.
    expect(spec.attachments?.map((file) => path.basename(file))).toEqual(method === "runs.start" ? [path.basename(image.path), "extra.png"] : undefined);
    const brief = spec.prompt;
    expect(brief).toContain(task.spec);
    expect(brief).toMatch(new RegExp(`Task images in document order \\(open them from these paths\\):\\n1\\. \\S*/${path.basename(image.path)}`));
  } finally {
    handle?.close();
    await vi.waitFor(() => expect(core.runs.liveRunForThread(parent.id)).toBeNull());
    adapter.mockRestore();
    models.mockRestore();
  }
});
