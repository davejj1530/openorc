import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projects, threads } from "@openorc/db";
import { WORKSPACE_ID, defaultOrclingLook, type AgentSkill, type CorePush, type RpcMethod, type RpcParams, type RpcResults } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";

let root: string;
let core: OpenOrc;
const pushed: CorePush[] = [];
let nextId = 1;

async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
  const id = nextId++;
  await core.handle({ type: "rpc", id, method, params });
  const reply = pushed.find((m) => (m.type === "rpc.result" || m.type === "rpc.error") && m.id === id);
  if (!reply) throw new Error("no reply");
  if (reply.type === "rpc.error") throw new Error(reply.message);
  return (reply as { result: RpcResults[M] }).result;
}

/** A Claude skill, as far as the listing reads it: a folder with a SKILL.md header. */
async function skill(skills: string, name: string) {
  await mkdir(path.join(skills, name), { recursive: true });
  await writeFile(path.join(skills, name, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} fixture.\n---\n`);
}

const found = (skills: AgentSkill[]) => skills.map((s) => `${s.source}:${s.name}`);

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-skills-")));
  // Personal skills resolve here, never in the real home.
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "claude"));
  await skill(path.join(root, "claude", "skills"), "humanizer");
  core = await OpenOrc.create({ dataDir: path.join(root, "data"), ephemeral: true, transport: { push: (message) => pushed.push(message) } });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await core?.close();
  await rm(root, { recursive: true, force: true });
});

describe("skills through RPC", () => {
  it("lists an Orcling's personal skills and the ones in the folder its conversation works in", async () => {
    const rini = await call("orclings.create", {
      draft: { name: "Rini", look: defaultOrclingLook, settings: { agent: "claude", model: "fixture", effort: null, fastMode: false }, permission: "allow" },
    });
    const folder = threads.get(core.db, rini.threadId)!.workingDirectory!;
    await skill(path.join(folder, ".claude", "skills"), "desk-notes");

    expect(found(await call("skills.list", { projectId: WORKSPACE_ID, workingDirectory: folder, agent: "claude" }))).toEqual(["project:desk-notes", "user:humanizer"]);
  });

  it("lists a Workspace conversation with no folder of its own from the Workspace's folder", async () => {
    const entrypoint = path.join(root, "entrypoint");
    await skill(path.join(entrypoint, ".claude", "skills"), "entry-notes");
    await call("workspace.configure", { entrypoint });

    expect(found(await call("skills.list", { projectId: WORKSPACE_ID, agent: "claude" }))).toEqual(["project:entry-notes", "user:humanizer"]);
  });

  it("lists a project's skills from its root, and gives no project another folder", async () => {
    const repo = path.join(root, "repo");
    await skill(path.join(repo, ".claude", "skills"), "repo-notes");
    const project = projects.insert(core.db, { name: "Repo", rootPath: repo, gitRemote: null, defaultBranch: null, settings: {} });

    expect(found(await call("skills.list", { projectId: project.id, agent: "claude" }))).toEqual(["user:humanizer", "project:repo-notes"]);
    await expect(call("skills.list", { projectId: project.id, workingDirectory: root, agent: "claude" })).rejects.toThrow("Only Workspace conversations can choose a working folder.");
  });
});
