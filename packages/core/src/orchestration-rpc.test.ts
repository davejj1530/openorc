import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { projects, settings, threads } from "@openorc/db";
import { git } from "@openorc/git";
import { DEFAULT_TEAM_LIMITS, type CorePush, type RpcMethod, type RpcParams, type RpcResults, type TeamDraft } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";

let core: OpenOrc;
let dir: string;
let projectId: string;
let nextId = 1;
const pushed: CorePush[] = [];
const handles: RunHandle[] = [];
const draft: TeamDraft = {
  name: "Build team",
  limits: { ...DEFAULT_TEAM_LIMITS },
  discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
  members: [{ key: "lead", name: "Lead", responsibility: "Coordinate the requested work.", managerKey: null, settings: { agent: "codex", model: "fixture-model", effort: "high", fastMode: false } }],
};

async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
  const id = nextId++;
  await core.handle({ type: "rpc", id, method, params });
  const reply = pushed.find((message) => (message.type === "rpc.result" || message.type === "rpc.error") && message.id === id);
  if (!reply || (reply.type !== "rpc.result" && reply.type !== "rpc.error")) throw new Error("No RPC response");
  if (reply.type === "rpc.error") throw new Error(reply.message);
  return reply.result as RpcResults[M];
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openorc-orchestration-rpc-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await writeFile(path.join(dir, "README.md"), "# Fixture\n");
  await git(dir, ["add", "README.md"]);
  await git(dir, ["commit", "-qm", "Fixture"]);
  core = await OpenOrc.create({ dataDir: path.join(dir, "data"), ephemeral: true, transport: { push: (message) => pushed.push(message) } });
  settings.set(core.db, "extraction.provider", "off");
  projectId = projects.insert(core.db, { name: "Fixture", rootPath: dir, gitRemote: null, defaultBranch: "main", settings: {} }).id;
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
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
    handles.push(handle);
    return handle;
  });
});

afterAll(async () => {
  for (const handle of handles) handle.close();
  if (core) await core.close();
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("orchestration RPC", () => {
  it("persists teams through the validated router and invalidates other windows", async () => {
    const saved = await call("orchestration.save", { projectId, expectedRevisionId: null, draft });
    expect(await call("orchestration.get", { id: saved.team.id })).toEqual(saved);
    expect(await call("orchestration.list", { projectId })).toEqual([saved]);
    expect(pushed).toContainEqual({ type: "invalidate", keys: ["orchestration", `orchestration:${projectId}`, `team:${saved.team.id}`] });
    const archived = await call("orchestration.archive", { projectId, teamId: saved.team.id, expectedRevisionId: saved.revision.id, archived: true });
    expect(archived.team.archivedAt).not.toBeNull();
    expect(await call("orchestration.list", { projectId })).toEqual([]);
    expect(await call("orchestration.list", { projectId, includeArchived: true })).toEqual([archived]);
    expect(threads.list(core.db)).toEqual([]);
    expect(handles).toEqual([]);
  });

  it("rejects disabled team execution before creating a conversation, workspace or provider run", async () => {
    await call("app.settings.set", { experimentalTeamExecution: false });
    const before = await git(dir, ["worktree", "list", "--porcelain"]);
    await expect(
      call("threads.start", {
        projectId,
        executionTarget: { kind: "team", teamRevisionId: "a-saved-revision" },
        mode: "act",
        permissionMode: "trusted",
        workspaceMode: "worktree",
        prompt: "Build it",
      }),
    ).rejects.toThrow("Team execution is disabled");
    expect(threads.list(core.db)).toEqual([]);
    expect(handles).toEqual([]);
    expect(await git(dir, ["worktree", "list", "--porcelain"])).toEqual(before);
  });

  it("normalizes a model execution target into the same settings as legacy callers", async () => {
    const base = { projectId, mode: "act", permissionMode: "trusted", workspaceMode: "current", prompt: "Say hello" } as const;
    const legacy = await call("threads.start", { ...base, agent: "codex", model: "fixture-model", effort: "high", fastMode: false });
    if (!legacy.run) throw new Error("A model launch must return its run.");
    await core.runs.closeAndWait(legacy.run.id);
    const target = await call("threads.start", { ...base, executionTarget: { kind: "model", settings: draft.members[0]!.settings } });
    for (const result of [legacy, target]) {
      expect(result.thread).toMatchObject({ agent: "codex", model: "fixture-model", effort: "high", fastMode: false });
      expect(result.run).toMatchObject({ agent: "codex", model: "fixture-model", effort: "high", fastMode: false });
    }
    expect(legacy.thread.id).not.toBe(target.thread.id);
    expect(handles).toHaveLength(2);
  });
});
