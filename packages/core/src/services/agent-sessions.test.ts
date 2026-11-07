import { existsSync, readFileSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeSessionFile, hostHome, sessionSlots, type AgentHome, type PackedSession, type SessionId } from "@openorc/agents";
import type { WorkspaceLocation } from "@openorc/cloud";
import { Db, projects, runs, threads } from "@openorc/db";
import type { Thread } from "@openorc/protocol";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentHomes } from "./agent-homes.js";
import { AgentSessions, keptSessionsFolder, type AgentHomes } from "./agent-sessions.js";
import { RelocationRefused } from "./relocation-package.js";

const ID = "0b9f3c3e-5d2a-4f1e-9c47-2a6f0d8e1b55" as SessionId;
const REPO = "/vercel/sandbox/repo";
const location = { repo: REPO } as WorkspaceLocation;
const line = (cwd: string, text: string) => `${JSON.stringify({ type: "user", cwd, sessionId: ID, text })}\n`;

let root: string;
let db: Db;
let thread: Thread;
let worktree: string;
let mac: string;
let sandbox: string;
let writes: string[];
/** Stands in for the CLI where only its version is asked: the one in `cli-version`, as `--version` prints it. */
let cli: string;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** A home on this disk whose writes are counted. */
const counted = (config: string): AgentHome => {
  const home = hostHome({ agent: "claude", userHome: root, env: { CLAUDE_CONFIG_DIR: config }, binary: cli, processEnv: {} });
  return { ...home, write: (file, bytes) => (writes.push(file), home.write(file, bytes)) };
};
const homes: AgentHomes = { here: () => counted(mac) as never, sandbox: async () => counted(sandbox) };
const sessions = () => new AgentSessions({ db, dataDir: path.join(root, "data"), homes, log: log as never });
const macFile = () => claudeSessionFile(mac, worktree, ID);
const sandboxFile = () => claudeSessionFile(sandbox, REPO, ID);
const kept = async () => {
  const folder = keptSessionsFolder(path.join(root, "data"), thread.id);
  const labels = existsSync(folder) ? await readdir(folder) : [];
  return labels.filter((label) => existsSync(path.join(folder, label, "part-0"))).map((label) => readFileSync(path.join(folder, label, "part-0"), "utf8"));
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-agent-sessions-")));
  mac = path.join(root, "mac-claude");
  sandbox = path.join(root, "sandbox-claude");
  worktree = path.join(root, "worktree");
  await mkdir(worktree);
  writes = [];
  cli = path.join(root, "cli");
  await writeFile(cli, `#!/bin/sh\necho "$(cat ${path.join(root, "cli-version")}) (stand-in)"\n`);
  await chmod(cli, 0o755);
  await writeFile(path.join(root, "cli-version"), "2.1.317");
  db = Db.memory();
  const project = projects.insert(db, { name: "App", rootPath: root, gitRemote: null, defaultBranch: "main", settings: {} });
  const created = threads.insert(db, { projectId: project.id, title: "Cloud", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
  thread = threads.update(db, created.id, { worktreePath: worktree });
  runs.insert(db, { id: "run-1", taskId: null, threadId: thread.id, agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
  runs.update(db, "run-1", { externalSessionId: ID });
  await mkdir(path.dirname(macFile()), { recursive: true });
  await writeFile(macFile(), line(worktree, "Start on the Mac"));
});

afterEach(async () => {
  db.close();
  vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});

it("sends the session to the sandbox under its folder there, and a turn's end brings it back under the worktree's", async () => {
  const base = await sessions().send(thread, location, "vercel");
  expect(await readFile(sandboxFile(), "utf8")).toBe(line(REPO, "Start on the Mac"));
  await appendFile(sandboxFile(), line(REPO, "A turn in the cloud"));
  const next = await sessions().keep(thread, location, "vercel", base, { required: false });
  expect(await readFile(macFile(), "utf8")).toBe(line(worktree, "Start on the Mac") + line(worktree, "A turn in the cloud"));
  expect(next).toEqual({ sessionId: ID, host: expect.any(String), sandbox: expect.any(String) });
  expect(next?.sandbox).not.toBe(base?.sandbox);
  expect(await kept()).toEqual([]);
});

it("writes nothing here when the sandbox's session did not change since what it got", async () => {
  const base = await sessions().send(thread, location, "vercel");
  writes.length = 0;
  expect(await sessions().keep(thread, location, "vercel", base, { required: false })).toEqual(base);
  expect(writes).toEqual([]);
});

it("keeps this host's copy aside when both sides changed, and takes the sandbox's, which holds the newest turn", async () => {
  const base = await sessions().send(thread, location, "vercel");
  await appendFile(macFile(), line(worktree, "The Mac's turn ran past the last send"));
  await appendFile(sandboxFile(), line(REPO, "The sandbox carried on"));
  await sessions().keep(thread, location, "vercel", base, { required: false });
  expect(await kept()).toEqual([line(worktree, "Start on the Mac") + line(worktree, "The Mac's turn ran past the last send")]);
  expect(await readFile(macFile(), "utf8")).toBe(line(worktree, "Start on the Mac") + line(worktree, "The sandbox carried on"));
  expect(await readFile(sandboxFile(), "utf8")).toBe(line(REPO, "Start on the Mac") + line(REPO, "The sandbox carried on"));
  expect(log.info).toHaveBeenCalledWith(expect.stringContaining("kept in"));
});

it("fails a leaving keep whose session did not come, and only warns after an ordinary turn", async () => {
  const broken: AgentHomes = { ...homes, sandbox: async () => ({ ...counted(sandbox), read: () => Promise.reject(new Error("sandbox gone")) }) };
  const leaving = new AgentSessions({ db, dataDir: path.join(root, "data"), homes: broken, log: log as never });
  await expect(leaving.keep(thread, location, "vercel", null, { required: true })).rejects.toThrow("sandbox gone");
  expect(await leaving.keep(thread, location, "vercel", null, { required: false })).toBeNull();
  expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("sandbox gone"));
});

it("takes a session where Claude looks for it in a folder reached through a link, its real path", async () => {
  const real = path.join(root, "data", "worktrees", "thread");
  await mkdir(real, { recursive: true });
  await symlink(path.join(root, "data"), path.join(root, "linked"));
  const packed: PackedSession = { ...(await exportWithoutVersion()), cliVersion: "2.1.317" };
  await sessions().take({ id: thread.id, agent: "claude", claudeAccountId: null, children: [] }, packed, path.join(root, "linked", "worktrees", "thread"), "r1", "cloud");
  expect(await readFile(claudeSessionFile(mac, real, ID), "utf8")).toBe(line(real, "Start on the Mac"));
  expect(existsSync(claudeSessionFile(mac, path.join(root, "linked", "worktrees", "thread"), ID))).toBe(false);
});

it("keeps a stale copy at the target aside under the move once, so repeating the take never loses it", async () => {
  const packed: PackedSession = { ...(await exportWithoutVersion()), cliVersion: "2.1.317" };
  const target = path.join(root, "target");
  await mkdir(target);
  const stale = claudeSessionFile(mac, target, ID);
  await mkdir(path.dirname(stale), { recursive: true });
  await writeFile(stale, line(target, "An older round trip"));
  const take = () => sessions().take({ id: thread.id, agent: "claude", claudeAccountId: null, children: [] }, packed, target, "r1", "cloud");
  await take();
  await take();
  expect(await kept()).toEqual([line(target, "An older round trip")]);
  expect(await readFile(stale, "utf8")).toBe(line(target, "Start on the Mac"));
});

it("refuses a session the CLI here could not resume, in words, and one of another agent", async () => {
  const packed: PackedSession = { ...(await exportWithoutVersion()), cliVersion: "2.1.317" };
  const cut = { ...packed, parts: [{ name: "session.jsonl", bytes: Buffer.from(line(worktree, "x").trimEnd()) }] };
  const take = (saved: PackedSession) => sessions().take({ id: thread.id, agent: "claude", claudeAccountId: null, children: [] }, saved, worktree, "r2", "cloud");
  await expect(take(cut)).rejects.toThrow(new RelocationRefused("Claude's conversation ends partway through a line."));
  await expect(take({ ...packed, agent: "codex" })).rejects.toThrow("belongs to another agent");
});

/** The Mac's session as its slot exports it, without running a CLI for its version. */
async function exportWithoutVersion() {
  return (await sessionSlots.claude.export(counted(mac), { sessionId: ID, cwd: worktree, children: [] }))!;
}

it("refuses a session a newer CLI wrote than the one here, naming which side to update, and takes one this CLI reads", async () => {
  const packed: PackedSession = { ...(await exportWithoutVersion()), cliVersion: "2.1.318" };
  const take = (from: "cloud" | "mac") => sessions().take({ id: thread.id, agent: "claude", claudeAccountId: null, children: [] }, packed, worktree, "r3", from);
  await expect(take("cloud")).rejects.toThrow(new RelocationRefused("This conversation last ran on Claude 2.1.318 in the cloud; this Mac has 2.1.317. Update Claude Code, then try again."));
  await expect(take("mac")).rejects.toThrow("on your Mac; the cloud brain has 2.1.317. Try again once the cloud brain has updated it.");
  expect(await kept()).toEqual([]);
  await writeFile(path.join(root, "cli-version"), "2.1.318");
  await take("cloud");
});

it("refuses, before anything is written, a thread whose agent's conversations stay, or whose Claude account is not here", () => {
  const taken = { id: thread.id, claudeAccountId: "gone", children: [] };
  expect(() => sessions().assertTakeable({ ...taken, agent: "acp" })).toThrow(new RelocationRefused("This agent's conversations stay where they started."));
  const environment = () => ({ env: {}, binaries: { claude: null, codex: null, opencode: null } }) as never;
  const real = new AgentSessions({ db, dataDir: path.join(root, "data"), homes: agentHomes({ environment, claudeFolder: () => null, agents: {} as never }), log: log as never });
  expect(() => real.assertTakeable({ ...taken, agent: "claude" })).toThrow(new RelocationRefused("Its Claude account is not here."));
  expect(() => real.assertTakeable({ ...taken, agent: "codex" })).not.toThrow();
});

describe("a take cut short by a crash", () => {
  /** A home here that dies at its `at`-th write, as a process killed partway through a take would. */
  const dying = (home: AgentHome, at: number): AgentHome => {
    let writes = 0;
    return { ...home, write: (file, bytes) => (++writes === at ? Promise.reject(new Error("died")) : home.write(file, bytes)) };
  };
  const take = (homes: AgentHomes, agent: "claude" | "codex", saved: PackedSession, folder: string) =>
    new AgentSessions({ db, dataDir: path.join(root, "data"), homes, log: log as never }).take({ id: thread.id, agent, claudeAccountId: null, children: [] }, saved, folder, "r1", "cloud");

  it.each([
    ["after the stale copy was kept aside", 1],
    ["partway through the import", 2],
  ])("converges when it runs again %s, a Claude session and its subagent landing whole", async (_when, at) => {
    const target = path.join(root, "target");
    await mkdir(target);
    const stale = claudeSessionFile(mac, target, ID);
    await mkdir(path.dirname(stale), { recursive: true });
    await writeFile(stale, line(target, "An older round trip"));
    const packed: PackedSession = { ...(await exportWithoutVersion()), cliVersion: "2.1.317" };
    const withSubagent = { ...packed, parts: [...packed.parts, { name: "subagents/agent-a1.jsonl", bytes: Buffer.from(line(worktree, "Looked around")) }] };
    await expect(take({ ...homes, here: () => dying(counted(mac), at) as never }, "claude", withSubagent, target)).rejects.toThrow("died");
    await take(homes, "claude", withSubagent, target);
    expect(await readFile(stale, "utf8")).toBe(line(target, "Start on the Mac"));
    expect(await readFile(path.join(stale.slice(0, -6), "subagents", "agent-a1.jsonl"), "utf8")).toBe(line(target, "Looked around"));
    expect(await kept()).toEqual([line(target, "An older round trip")]);
  });

  it("converges when it runs again after some of a Codex conversation's rollouts were written, its bytes exact", async () => {
    const rollout = (id: string, extra = "") => `sessions/2026/11/05/rollout-2026-11-05T00-00-00-${id}.jsonl${extra}`;
    const fork = `${JSON.stringify({ type: "session_meta", payload: { id: ID, history_base: { thread_id: "parent-1" } } })}\n`;
    const parent = `${JSON.stringify({ type: "session_meta", payload: { id: "parent-1" } })}\n`;
    const saved: PackedSession = {
      agent: "codex",
      format: 1,
      cliVersion: "0.166.0",
      sessionId: ID,
      meta: { selected: rollout(ID) },
      parts: [
        { name: rollout(ID), bytes: Buffer.from(fork) },
        { name: rollout("parent-1"), bytes: Buffer.from(parent) },
      ],
    };
    const codexHome = path.join(root, "mac-codex");
    await mkdir(path.join(codexHome, "sessions", "2026", "11", "05"), { recursive: true });
    const older = `${JSON.stringify({ type: "session_meta", payload: { id: ID } })}\nan older turn\n`;
    await writeFile(path.join(codexHome, rollout(ID)), older);
    const base = hostHome({ agent: "codex", userHome: root, env: { CODEX_HOME: codexHome }, binary: cli, processEnv: {} });
    // The check's stand-in: resumes the thread when its rollout is in place.
    const codex = (at: number) => ({
      ...dying(base, at),
      spawn: () =>
        spawn(
          process.execPath,
          [
            "-e",
            `require("node:readline").createInterface({ input: process.stdin }).on("line", (l) => { const m = JSON.parse(l); if (m.id !== undefined) process.stdout.write(JSON.stringify({ id: m.id, result: { thread: { id: ${JSON.stringify(ID)} } } }) + "\\n"); });`,
          ],
          { stdio: ["pipe", "pipe", "pipe"], detached: true },
        ),
    });
    await writeFile(path.join(root, "cli-version"), "0.166.0");
    await expect(take({ ...homes, here: () => codex(2) as never }, "codex", saved, worktree)).rejects.toThrow("died");
    await take({ ...homes, here: () => codex(0) as never }, "codex", saved, worktree);
    expect(await readFile(path.join(codexHome, rollout(ID)), "utf8")).toBe(fork);
    expect(await readFile(path.join(codexHome, rollout("parent-1")), "utf8")).toBe(parent);
    expect(await kept()).toEqual([older]);
  });
});
