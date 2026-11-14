import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AcpAdapter, ClaudeAdapter, CodexAdapter, LiveInputUnavailable, RunHandle } from "@openorc/agents";
import { threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import type { Project } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { rpcClient } from "../rpc-test-client.js";

let root: string;
let dataDir: string;
let core: OpenOrc;
let project: Project;
const call = rpcClient(() => core);
const live: string[] = [];

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-note-repo-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-note-data-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "# Note fixture\n");
  await commitAll(root, "init");
  core = await OpenOrc.create({ dataDir, ephemeral: true, transport: { push: () => {} } });
  project = await core.projects.import(root);
});
afterEach(async () => {
  await Promise.all(live.splice(0).map((id) => core.runs.closeAndWait(id)));
  vi.restoreAllMocks();
});
afterAll(async () => {
  await core.close();
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

const ADAPTERS = { claude: ClaudeAdapter, codex: CodexAdapter, opencode: AcpAdapter } as const;
type Agent = keyof typeof ADAPTERS;

/** A run of `agent` mid-turn, whose process takes what it is sent as a message to the running turn, or refuses one. */
async function running(agent: Agent, { refuse = false } = {}) {
  const sent: string[] = [];
  let handle!: RunHandle;
  vi.spyOn(ADAPTERS[agent].prototype, "start").mockImplementation((spec: { runId: string }) => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => (finish = resolve));
    handle = new RunHandle(spec.runId, {
      send: async (text) => {
        if (refuse) throw new LiveInputUnavailable("Wait for the turn to finish.");
        sent.push(text);
      },
      interrupt() {},
      close() {
        handle.emit("exit", 0);
        finish(0);
      },
      done,
    });
    return handle;
  });
  const thread = threads.insert(core.db, { projectId: project.id, title: `${agent} note`, agent, model: "fixture", mode: "act", permissionMode: "review" });
  const run = await core.runs.start({ scope: { thread, task: null }, project, agent, model: "fixture", mode: "act", permissionMode: "review", prompt: "Build the website", resume: false });
  live.push(run.id);
  handle.emit("event", { type: "session.started", runId: run.id, ts: Date.now(), agent, externalSessionId: `${agent}-note`, model: "fixture" });
  return { run, thread, sent };
}

describe.each(Object.keys(ADAPTERS) as Agent[])("a denial with a note, for %s", (agent) => {
  it("denies the request, then sends the note to the same run as the person's next message", async () => {
    const { run, sent } = await running(agent);
    const asked = core.runs.requestApproval(run.id, "build", "Bash", { command: "pnpm --filter website build" });
    await call("approvals.resolve", { runId: run.id, approvalId: "build", decision: "deny", note: "Build only the pricing page" });
    await expect(asked).resolves.toMatchObject({ decision: "deny" });
    expect(sent).toEqual([expect.stringContaining("Build only the pricing page")]);
  });

  it("queues the note for the thread when the turn takes no message now", async () => {
    const { run, thread, sent } = await running(agent, { refuse: true });
    const queue = vi.spyOn(core.threads, "queue");
    const asked = core.runs.requestApproval(run.id, "build", "Bash", { command: "pnpm --filter website build" });
    await call("approvals.resolve", { runId: run.id, approvalId: "build", decision: "deny", note: "Build only the pricing page" });
    await expect(asked).resolves.toMatchObject({ decision: "deny" });
    expect(sent).toEqual([]);
    expect(queue.mock.calls.map(([id, text]) => [id, text])).toEqual([[thread.id, "Build only the pricing page"]]);
  });

  it("sends nothing more with an allow, or a denial without a note", async () => {
    const { run, sent } = await running(agent);
    const allowed = core.runs.requestApproval(run.id, "a", "Bash", {});
    await call("approvals.resolve", { runId: run.id, approvalId: "a", decision: "allow", note: "ignored" });
    const denied = core.runs.requestApproval(run.id, "b", "Bash", {});
    await call("approvals.resolve", { runId: run.id, approvalId: "b", decision: "deny" });
    await expect(Promise.all([allowed, denied])).resolves.toMatchObject([{ decision: "allow" }, { decision: "deny" }]);
    expect(sent).toEqual([]);
  });
});
