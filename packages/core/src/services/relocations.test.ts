import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalSandboxProvider } from "@openorc/cloud";
import { deleteThreadRows, relocations, runs as runRows, settings, threadQueue, threads } from "@openorc/db";
import { commitAll, git, worktree } from "@openorc/git";
import { DEFAULT_CLAUDE_ACCOUNT, MOVING_WORDS, type Project } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import type { OpenOrcOptions } from "../options.js";
import { FAKE_CLAUDE, turnsIn, until } from "../test-fixtures/fake-claude.js";
import { claudeSessionFile } from "@openorc/agents";
import { inheritedProbe } from "./shell-environment.js";

let root: string;
let config: string;
let log: string;
let env: NodeJS.ProcessEnv;
let checkout: string;
const cores: OpenOrc[] = [];
const turns = () => turnsIn(log);
const turn = { agent: "claude", model: "fixture", effort: undefined, mode: "act", permissionMode: "autonomous", attachments: undefined } as const;

function tokenStore(): NonNullable<OpenOrcOptions["claudeCloudSecrets"]> {
  let saved: string | null = JSON.stringify({ [DEFAULT_CLAUDE_ACCOUNT]: { token: "sk-ant-oat01-fixture", createdAt: 1 } });
  return { load: async () => saved, save: async (value) => void (saved = value) };
}

async function open(name: string, options: Partial<OpenOrcOptions> = {}): Promise<OpenOrc> {
  const core = await OpenOrc.create({ dataDir: path.join(root, name), ephemeral: true, transport: { push: () => {} }, shellProbe: inheritedProbe(env), ...options });
  settings.set(core.db, "extraction.provider", "off");
  vi.spyOn(core.textGeneration, "title").mockResolvedValue(null);
  vi.spyOn(core.runs, "models").mockResolvedValue([{ id: "fixture", label: "Fixture", agent: "claude", isDefault: true, efforts: ["high"], defaultEffort: "high", fastMode: { supported: false } }]);
  cores.push(core);
  return core;
}

/** The brain as far as relocation can tell: a cloud-only core whose thread sandboxes are folders here. */
const openBrain = () => {
  // A sandbox's Claude keeps sessions under its own home, as on Vercel; it signs in with the account's cloud token.
  const sandboxEnv = { ...env, CLAUDE_CONFIG_DIR: undefined, HOME: path.join(root, "sandbox-home") };
  return open("brain", { cloudOnly: true, deviceSystem: null, claudeCloudSecrets: tokenStore(), cloudSandboxes: new LocalSandboxProvider(path.join(root, "sandboxes"), () => sandboxEnv, 1500) });
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-relocations-")));
  checkout = path.join(root, "app");
  await mkdir(checkout);
  await git(checkout, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(checkout, "README.md"), "# Relocation fixture\n");
  await commitAll(checkout, "Fixture baseline");
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "claude"), FAKE_CLAUDE);
  await chmod(path.join(bin, "claude"), 0o755);
  config = path.join(root, "claude-config");
  log = path.join(root, "turns.jsonl");
  env = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, CLAUDE_CONFIG_DIR: config, FAKE_LOG: log, OPENORC_CLAUDE_BIN: path.join(bin, "claude") };
  vi.stubEnv("CLAUDE_CONFIG_DIR", config);
  vi.stubEnv("FAKE_LOG", log);
});

afterEach(async () => {
  for (const core of cores.splice(0).reverse()) await core.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** A Mac thread that ran one turn in a worktree of its own and left a change uncommitted. */
async function macThread(mac: OpenOrc, project: Project) {
  const { thread } = await mac.threads.start({ ...turn, title: "Relocate me", projectId: project.id, prompt: "Start here", workspaceMode: "worktree" });
  await until(() => turns().length === 1 && mac.runs.threadActivity(thread.id) === "idle");
  const worktreePath = mac.threads.get(thread.id)!.worktreePath!;
  await writeFile(path.join(worktreePath, "feature.md"), "committed on the thread's branch\n");
  await commitAll(worktreePath, "Thread work");
  await writeFile(path.join(worktreePath, "draft.md"), "not committed yet\n");
  return { thread: mac.threads.get(thread.id)!, worktreePath, sessionId: turns()[0]!.id };
}

it("moves a Mac thread to the brain, where Claude resumes in its sandbox, and back to the Mac", async () => {
  const mac = await open("mac");
  const project = await mac.projects.import(checkout);
  const brain = await openBrain();
  const copy = path.join(root, "brain", "projects", project.id, "app");
  await git(root, ["clone", "-q", checkout, copy]);
  const brainProject = await brain.projects.import(copy);
  const { thread, worktreePath, sessionId } = await macThread(mac, project);
  const main = (await git(checkout, ["rev-parse", "main"])).stdout.trim();

  const shot = path.join(root, "mac", "attachments", "shot.png");
  await mkdir(path.dirname(shot), { recursive: true });
  await writeFile(shot, "png bytes");
  mac.threads.recordMessage(thread.id, { id: "note", role: "user", text: "See this", createdAt: Date.now(), attachments: [shot] });
  const pins = async (repo: string) => (await git(repo, ["for-each-ref", "--format=%(refname)", `refs/openorc/checkpoints/${thread.id}/`])).stdout.split("\n").filter(Boolean);
  expect(await pins(checkout)).not.toEqual([]);

  // Queued on the Mac while it was busy: it travels with the thread and is delivered on the brain.
  threadQueue.enqueue(mac.db, { threadId: thread.id, text: "Carry on in the cloud", attachments: [], requestKey: "queued" });
  const sent = await mac.relocations.pack("r1", thread.id, { from: "mac", macProject: project.id, since: [main] });
  const arrival = {
    projectId: () => brainProject.id,
    place: "cloud",
    commit: () => void relocations.open(brain.db, { id: "r1", threadId: thread.id, role: "brain", direction: "to-cloud", phase: "arrived", projectId: brainProject.id }),
  } as const;
  expect(await brain.relocations.take(sent, arrival)).toBe("taken");
  expect(await brain.relocations.take(sent, arrival)).toBe("already");
  const arrived = brain.threads.get(thread.id)!;
  expect(arrived).toMatchObject({ projectId: brainProject.id, title: "Relocate me", branch: thread.branch });
  expect(readFileSync(path.join(arrived.worktreePath!, "draft.md"), "utf8")).toBe("not committed yet\n");
  expect((await git(arrived.worktreePath!, ["status", "--porcelain"])).stdout).toContain("draft.md");
  expect(await pins(copy)).toEqual(await pins(checkout));
  const brainShot = path.join(root, "brain", "attachments", "shot.png");
  expect(readFileSync(brainShot, "utf8")).toBe("png bytes");
  expect(brain.threads.messages(thread.id).find((message) => message.id === "note")?.attachments).toEqual([brainShot]);
  await until(() => {
    const state = brain.threads.get(thread.id)!.cloud;
    if (state?.state === "failed") throw new Error(state.error ?? "failed");
    return state?.state === "ready";
  });

  await until(() => turns().length === 2 && brain.runs.threadActivity(thread.id) === "idle");
  expect(turns()[1]?.prompt).toContain("Carry on in the cloud");
  const repo = path.join(root, "sandboxes", `openorc-${thread.id}`, "repo");
  expect(turns()[1]).toMatchObject({ cwd: repo, id: sessionId, resumed: true, earlier: 1 });
  expect(existsSync(path.join(repo, "draft.md"))).toBe(true);
  // The turn's end keeps the session on the brain, where its next package reads it.
  await until(() => readFileSync(claudeSessionFile(config, arrived.worktreePath!, sessionId), "utf8").includes("Carry on in the cloud"));

  // The Mac lets its copy go, as a settled move does.
  mac.db.transaction(() => deleteThreadRows(mac.db, thread.id));
  await worktree.remove(checkout, worktreePath, { force: true });
  const back = await brain.relocations.pack("r2", thread.id, { from: "cloud", macProject: project.id, since: [] });
  expect(await mac.relocations.take(back, { projectId: (id) => id, place: "here", commit: () => undefined })).toBe("taken");
  const home = mac.threads.get(thread.id)!;
  expect(home.cloud ?? null).toBeNull();
  expect(readFileSync(path.join(home.worktreePath!, "draft.md"), "utf8")).toBe("not committed yet\n");
  await mac.threads.continueThread(thread.id, { ...turn, prompt: "Home again" });
  await until(() => turns().length === 3 && mac.runs.threadActivity(thread.id) === "idle");
  expect(turns()[2]).toMatchObject({ cwd: home.worktreePath, id: sessionId, resumed: true, earlier: 2 });
}, 90_000);

it("refuses a package whose code builds on a commit the target lacks, and takes a whole one", async () => {
  const mac = await open("mac");
  const project = await mac.projects.import(checkout);
  const { thread } = await macThread(mac, project);
  const other = await open("other");
  const empty = path.join(root, "empty");
  await mkdir(empty);
  await git(empty, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(empty, "x"), "x");
  await commitAll(empty, "unrelated");
  const target = await other.projects.import(empty);
  const main = (await git(checkout, ["rev-parse", "main"])).stdout.trim();
  const take = async (since: string[]) =>
    other.relocations.take(await mac.relocations.pack("r", thread.id, { from: "mac", macProject: project.id, since }), {
      projectId: () => target.id,
      place: "here",
      commit: () => undefined,
    });
  await expect(take([main])).rejects.toThrow(/lacks the commit/);
  expect(threads.get(other.db, thread.id)).toBeNull();
  expect(await take([])).toBe("taken");
}, 60_000);

it("refuses a turn whose launch was under way when the thread froze", async () => {
  const mac = await open("mac");
  const project = await mac.projects.import(checkout);
  const { thread } = await macThread(mac, project);
  const host = mac.cloud.host.bind(mac.cloud);
  let froze = false;
  vi.spyOn(mac.cloud, "host").mockImplementation(async (...args) => {
    if (!froze) relocations.open(mac.db, { id: "r", threadId: thread.id, role: "coordinator", direction: "to-cloud", phase: "frozen", projectId: project.id });
    froze = true;
    return host(...args);
  });
  const outcome = await mac.threads.continueThread(thread.id, { ...turn, prompt: "Racing the move" }).then(
    (run) => run,
    (error: unknown) => error,
  );
  expect(froze).toBe(true);
  await until(() => mac.runs.threadActivity(thread.id) === "idle");
  const failure = outcome instanceof Error ? outcome.message : runRows.listForThread(mac.db, thread.id).at(-1)?.error;
  expect(failure).toBe(MOVING_WORDS.cloud);
  expect(turns()).toHaveLength(1);
}, 60_000);

it("refuses sends, queued messages and changes to a frozen thread, across a restart", async () => {
  const dataDir = path.join(root, "disk");
  let mac = await OpenOrc.create({ dataDir, transport: { push: () => {} }, shellProbe: inheritedProbe(env) });
  cores.push(mac);
  vi.spyOn(mac.textGeneration, "title").mockResolvedValue(null);
  vi.spyOn(mac.runs, "models").mockResolvedValue([{ id: "fixture", label: "Fixture", agent: "claude", isDefault: true, efforts: ["high"], defaultEffort: "high", fastMode: { supported: false } }]);
  const project = await mac.projects.import(checkout);
  const { thread } = await macThread(mac, project);
  relocations.open(mac.db, { id: "r", threadId: thread.id, role: "coordinator", direction: "to-cloud", phase: "frozen", projectId: project.id });
  const refused = async (core: OpenOrc) => {
    await expect(core.threads.continueThread(thread.id, { ...turn, prompt: "Now" })).rejects.toThrow(MOVING_WORDS.cloud);
    const queued = await core.handle({ type: "rpc", id: 1, method: "threads.queue", params: { id: thread.id, text: "Later" } });
    expect(queued).toMatchObject({ type: "rpc.error", message: MOVING_WORDS.cloud });
    const renamed = await core.handle({ type: "rpc", id: 2, method: "threads.update", params: { id: thread.id, patch: { title: "Renamed" } } });
    expect(renamed).toMatchObject({ type: "rpc.error", message: MOVING_WORDS.cloud });
    const deleted = await core.handle({ type: "rpc", id: 3, method: "threads.delete", params: { id: thread.id } });
    expect(deleted).toMatchObject({ type: "rpc.error", message: MOVING_WORDS.cloud });
    expect(core.threads.get(thread.id)?.moving).toMatchObject({ to: "cloud" });
  };
  await refused(mac);
  await mac.close();
  cores.splice(cores.indexOf(mac), 1);
  mac = await OpenOrc.create({ dataDir, transport: { push: () => {} }, shellProbe: inheritedProbe(env) });
  cores.push(mac);
  await refused(mac);
  expect(turns()).toHaveLength(1);
  relocations.advance(mac.db, "r", "frozen", "abandoned");
  expect(mac.threads.get(thread.id)?.moving ?? null).toBeNull();
}, 60_000);
