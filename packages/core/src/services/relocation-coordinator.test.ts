import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeSessionFile, hostHome, sessionSlots, type SessionId } from "@openorc/agents";
import { BrainUnavailable, LocalSandboxProvider, type BrainControlResults } from "@openorc/cloud";
import { claudeAccounts, cloudWorkspaces, frozenMoving, incomingMove, LedgerWriter, relocations, runs, snapshots, tasks, threads } from "@openorc/db";
import { commitAll, git, pinObject, treeHash, worktree } from "@openorc/git";
import { DEFAULT_CLAUDE_ACCOUNT, MOVING_WORDS, type Project } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import type { OpenOrcOptions } from "../options.js";
import { FAKE_CLAUDE, until } from "../test-fixtures/fake-claude.js";
import { FAKE_CODEX_RESUME } from "../test-fixtures/fake-codex.js";
import { FAKE_OPENCODE } from "../test-fixtures/fake-opencode.js";
import { inheritedProbe } from "./shell-environment.js";
import { BrainMirrors, mirrorFolder, snapshotFolder } from "./brain-mirrors.js";
import type { AwakeBrain, BrainChannel, RelocationCoordinator } from "./relocation-coordinator.js";

class Died extends Error {}

type Agent = "claude" | "codex" | "opencode";
/** Each host's agent folders and stand-in CLIs, apart from the person's own; a sandbox's home is apart from both. */
const homeOf = (name: "mac" | "brain" | "sandbox") => path.join(root, `${name}-home`);
function hostEnv(name: "mac" | "brain" | "sandbox"): NodeJS.ProcessEnv {
  const bin = path.join(root, "bin");
  const home = homeOf(name);
  const folders =
    name === "sandbox"
      ? { CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, XDG_DATA_HOME: undefined }
      : { CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CODEX_HOME: path.join(home, ".codex"), XDG_DATA_HOME: path.join(home, "data") };
  const bins = { OPENORC_CLAUDE_BIN: path.join(bin, "claude"), OPENORC_CODEX_BIN: path.join(bin, "codex"), OPENORC_OPENCODE_BIN: path.join(bin, "opencode") };
  return { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOME: home, ...folders, ...bins };
}

let root: string;
let checkout: string;
let brain: OpenOrc;
let brainCopy: Project;
let main: string;
let mac: OpenOrc | null;
let project: Project;
/** The Mac is down: its brain calls go nowhere, as a dead process's would. */
let dead = false;
/** The step to die at, and how many of that name to pass first. */
let dieAt: { step: string; after: number } | null = null;
/** Receives the brain has taken off the wire but not yet answered, as when a reply is lost. */
let held: (() => Promise<unknown>)[] = [];
let holdReceives = false;
let loseNextReply = false;
/** Receives that fail the way a brain stopping mid-operation does, through the Mac's CloudBrain. */
let failReceives = 0;
/** Hand-offs that fail the same way, after the brain was woken. */
let failHandOffs = 0;
/** The brain sleeps: only an operation that wakes it reaches it. */
let asleep = false;
/** Brain operations that woke it first. */
let wakes = 0;
/** The Mac project of a brain copy, as the brain finds it from the folder the copy lives in. */
let macProjectOf: (projectId: string) => string | null = () => project.id;
/** The Mac's warnings. */
let warnings: string[] = [];
/** The thread whose move's step, as this Mac's windows read it, is noted at every brain call. */
let watched: string | null = null;
let stepsSeen: string[] = [];
function noteStep(): void {
  if (!watched || !mac) return;
  const step = frozenMoving(mac.db, watched)?.step ?? incomingMove(mac.db, watched)?.step ?? "none";
  if (stepsSeen.at(-1) !== step) stepsSeen.push(step);
}

function tokenStore(): NonNullable<OpenOrcOptions["claudeCloudSecrets"]> {
  let saved: string | null = JSON.stringify({ [DEFAULT_CLAUDE_ACCOUNT]: { token: "sk-ant-oat01-fixture", createdAt: 1 } });
  return { load: async () => saved, save: async (value) => void (saved = value) };
}

const inbox = () => path.join(root, "brain-inbox");
const outbox = () => path.join(root, "brain-outbox");

/** The brain's control ops, as apps/brain wires them onto its core, over an inbox and outbox here. */
const awakeBrain: AwakeBrain = {
  receive: async (relocation, bytes) => {
    if (dead) throw new Error("dead");
    noteStep();
    if (failReceives > 0) {
      failReceives--;
      throw new Error("The cloud brain is not running.");
    }
    await mkdir(inbox(), { recursive: true });
    const file = path.join(inbox(), `${relocation}-${Math.random()}.thread`);
    await writeFile(file, bytes);
    const take = () => brain.relocations.receive(relocation, file, () => brainCopy.id).finally(() => rm(file, { force: true }));
    if (holdReceives) {
      held.push(take);
      throw new BrainUnavailable();
    }
    const answer = await take();
    if (loseNextReply) {
      loseNextReply = false;
      throw new BrainUnavailable();
    }
    return answer;
  },
  ask: async (request) => {
    if (dead) throw new Error("dead");
    noteStep();
    const ops = brain.relocations;
    switch (request.op) {
      case "drop-arrival":
        return ops.dropArrival(request.relocation, request.threadId) as never;
      case "hand-off-thread":
        if (failHandOffs > 0 && failHandOffs--) throw new Error("The cloud brain is not running.");
        return (await ops.handOff(request.relocation, request.threadId, outbox(), (projectId) => macProjectOf(projectId))) as never;
      case "cancel-hand-off":
        return (await ops.cancelHandOff(request.relocation, request.threadId, outbox())) as never;
      case "handed-off":
        return (await ops.handedOff(request.relocation, outbox())) as never;
    }
    throw new Error("unexpected request");
  },
  download: async (file) => {
    if (dead) throw new Error("dead");
    noteStep();
    return readFile(path.join(outbox(), file));
  },
};

/** Whether a starting Mac resumes its moves; off, to act on a move before the drive does. */
let resumes = true;
const channel: BrainChannel = {
  ready: async () => resumes,
  copy: async () => ({ sent: main }),
  awake: async (work, wake = true) => {
    noteStep();
    if (wake) wakes++;
    else if (asleep) throw new BrainUnavailable();
    return work(awakeBrain);
  },
  gone: async () => false,
};

const passed = new Map<string, number>();
function step(name: string): void {
  if (!dieAt || dieAt.step !== name) return;
  const seen = passed.get(name) ?? 0;
  passed.set(name, seen + 1);
  if (seen < dieAt.after) return;
  dieAt = null;
  dead = true;
  throw new Died(name);
}

async function openMac(retryMs = 20): Promise<OpenOrc> {
  dead = false;
  const push: OpenOrcOptions["transport"]["push"] = (message) => void (message.type === "log" && message.level === "warn" && warnings.push(message.message));
  mac = await OpenOrc.create({
    dataDir: path.join(root, "mac"),
    transport: { push },
    shellProbe: inheritedProbe(hostEnv("mac")),
    shellEnv: hostEnv("mac"),
    brainChannel: channel,
    relocationTiming: { retryMs, step },
  });
  return mac;
}

/** The Mac dies where it stands and starts again on the same ledger, resuming its moves. */
async function restart(): Promise<OpenOrc> {
  await mac?.close().catch(() => undefined);
  return openMac();
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-relocation-matrix-")));
  checkout = path.join(root, "app");
  await mkdir(checkout);
  await git(checkout, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(checkout, "README.md"), "# Matrix\n");
  await commitAll(checkout, "Baseline");
  main = (await git(checkout, ["rev-parse", "main"])).stdout.trim();
  await mkdir(path.join(root, "bin"));
  for (const [name, script] of [
    ["claude", FAKE_CLAUDE],
    ["codex", FAKE_CODEX_RESUME],
    ["opencode", FAKE_OPENCODE],
  ] as const) {
    await writeFile(path.join(root, "bin", name), script);
    await chmod(path.join(root, "bin", name), 0o755);
  }
  [dead, dieAt, held, holdReceives, loseNextReply, resumes, failReceives, warnings, watched, stepsSeen, failHandOffs] = [false, null, [], false, false, true, 0, [], null, [], 0];
  [asleep, wakes, macProjectOf] = [false, 0, () => project.id];
  passed.clear();
  await openMac();
  project = await mac!.projects.import(checkout);
  brain = await OpenOrc.create({
    dataDir: path.join(root, "brain"),
    ephemeral: true,
    transport: { push: () => {} },
    cloudOnly: true,
    deviceSystem: null,
    shellProbe: inheritedProbe(hostEnv("brain")),
    shellEnv: hostEnv("brain"),
    claudeCloudSecrets: tokenStore(),
    cloudSandboxes: new LocalSandboxProvider(path.join(root, "sandboxes"), () => hostEnv("sandbox"), 1500),
  });
  const copy = path.join(root, "brain", "projects", project.id, "app");
  await git(root, ["clone", "-q", checkout, copy]);
  brainCopy = await brain.projects.import(copy);
});

afterEach(async () => {
  await mac?.close().catch(() => undefined);
  await brain.close();
  // The brain may still be seeding a thread's sandbox, and git writing objects, as the folder goes.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** A Mac thread with a run of events, its agent's session, a commit on its own branch and a change not committed. */
const macThread = (agent: Agent = "claude"): Promise<string> => threadOn(mac!, project.id, checkout, agent);

/** The agent's session for a thread, in that agent's own layout at a host's folders, as its CLI writes it. */
async function writeSession(core: OpenOrc, agent: Agent, sessionId: string, folder: string): Promise<void> {
  const home = homeOf(core === mac ? "mac" : "brain");
  const line = (value: object) => `${JSON.stringify(value)}\n`;
  if (agent === "claude") {
    const file = claudeSessionFile(path.join(home, ".claude"), realpathSync(folder), sessionId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, line({ type: "user", cwd: folder, sessionId, text: "Started here" }));
  } else if (agent === "opencode") {
    const file = path.join(home, "data", "fake-opencode", `${sessionId}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ info: { id: sessionId, location: { directory: folder } }, messages: [{ id: "msg_1", type: "user", text: "Started here" }] }));
  } else {
    const file = path.join(home, ".codex", "sessions", "2026", "11", "05", `rollout-2026-11-05T00-00-00-${sessionId}.jsonl`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, line({ type: "session_meta", payload: { id: sessionId, cwd: folder } }) + line({ type: "response_item", payload: { text: "Started here" } }));
  }
}

/** Whether the thread's agent resumes its newest session at a host, from the thread's folder there, as its CLI would. */
async function resumable(core: OpenOrc, threadId: string): Promise<boolean> {
  const thread = threads.get(core.db, threadId)!;
  const agent = thread.agent as Agent;
  const env = hostEnv(core === mac ? "mac" : "brain");
  const folders: Record<string, string> = { claude: { CLAUDE_CONFIG_DIR: env["CLAUDE_CONFIG_DIR"]! }, codex: { CODEX_HOME: env["CODEX_HOME"]! }, opencode: { XDG_DATA_HOME: env["XDG_DATA_HOME"]! } }[
    agent
  ];
  const home = hostHome({ agent, userHome: env["HOME"]!, env: folders, binary: env[`OPENORC_${agent.toUpperCase()}_BIN`]!, processEnv: env });
  const sessionId = runs.get(core.db, `run-${threadId}`)?.externalSessionId as SessionId;
  const ref = { sessionId, cwd: realpathSync(thread.worktreePath!), children: [] };
  const saved = await sessionSlots[agent].export(home, ref);
  return Boolean(saved?.parts[0]?.bytes.toString().includes("Started here")) && (await sessionSlots[agent].check(home, ref)) === null;
}

/** Such a thread on either host: on the brain, one started there, whose branch this Mac never had. */
async function threadOn(core: OpenOrc, projectId: string, repo: string, agent: Agent = "claude"): Promise<string> {
  const db = core.db;
  const thread = threads.insert(db, { projectId, title: "Matrix thread", agent, model: null, mode: "act", permissionMode: "autonomous", workspaceMode: "worktree" });
  const folder = path.join(root, core === mac ? "mac" : "brain", "worktrees", thread.id);
  await worktree.add(repo, { path: folder, branch: `openorc/${thread.id.slice(0, 8)}`, startPoint: "main" });
  await writeFile(path.join(folder, "feature.md"), "committed\n");
  await commitAll(folder, "Feature");
  await writeFile(path.join(folder, "draft.md"), "uncommitted\n");
  threads.update(db, thread.id, { worktreePath: folder, branch: `openorc/${thread.id.slice(0, 8)}` });
  const sessionId = agent === "opencode" ? `ses_${thread.id.slice(0, 8)}` : `s${thread.id.slice(0, 8)}-${agent}`;
  runs.insert(db, { id: `run-${thread.id}`, taskId: null, threadId: thread.id, agent, model: null, mode: "act", permissionMode: "autonomous" });
  runs.update(db, `run-${thread.id}`, { state: "success", endedAt: 2, externalSessionId: sessionId });
  await writeSession(core, agent, sessionId, folder);
  const ledger = new LedgerWriter(db);
  for (let index = 0; index < 5; index++) ledger.push({ type: "message.completed", runId: `run-${thread.id}`, ts: index, messageId: `m${index}`, role: "assistant", text: `line ${index}` } as never);
  ledger.close();
  return thread.id;
}

/** Who holds the thread, unfrozen, and what it holds. */
async function holders(threadId: string) {
  const held = [];
  for (const [name, core] of [
    ["mac", mac!],
    ["brain", brain],
  ] as const) {
    const thread = threads.get(core.db, threadId);
    if (!thread) continue;
    const events = (core.db.stmt("SELECT COUNT(*) AS c FROM events WHERE run_id IN (SELECT id FROM runs WHERE thread_id = ?)").get(threadId) as { c: number }).c;
    const read = (file: string) => (thread.worktreePath && existsSync(path.join(thread.worktreePath, file)) ? readFileSync(path.join(thread.worktreePath, file), "utf8") : null);
    held.push({ name, frozen: frozenMoving(core.db, threadId) !== null, title: thread.title, events, feature: read("feature.md"), draft: read("draft.md"), resumes: await resumable(core, threadId) });
  }
  return held;
}

const content = { frozen: false, title: "Matrix thread", events: 5, feature: "committed\n", draft: "uncommitted\n", resumes: true };
const settledHere = () => relocations.unsettled(mac!.db).length === 0;

async function moveUp(threadId: string): Promise<void> {
  await mac!.handle({ type: "rpc", id: 1, method: "cloud.move", params: { threadId } });
}

async function bringHome(threadId: string): Promise<void> {
  await mac!.handle({ type: "rpc", id: 2, method: "cloud.bringToMac", params: { threadId } });
}

describe.each(["claude", "codex", "opencode"] as const)("a crash after every step leaves exactly one owner, with the %s thread whole and resumable", (agent) => {
  for (const at of ["frozen", "sending", "receive answered", "let go", "done"])
    it(`to the cloud, the Mac dying at ${at}`, async () => {
      const threadId = await macThread(agent);
      const folder = threads.get(mac!.db, threadId)!.worktreePath!;
      dieAt = { step: at, after: 0 };
      await moveUp(threadId);
      // A Mac that dies after the move settles has let its copy go first, as the dying process would have.
      await until(() => dead || (settledHere() && relocations.withCleanup(mac!.db).length === 0));
      await restart();
      await until(() => settledHere() && relocations.withCleanup(mac!.db).length === 0);
      expect(await holders(threadId)).toEqual([{ name: "brain", ...content }]);
      // The Mac's worktree is retired, its last state kept on a ref of the thread's own.
      expect(existsSync(folder)).toBe(false);
      expect((await git(checkout, ["rev-parse", "--verify", "--quiet", `refs/openorc/relocated/${threadId}`], { okCodes: [0, 1] })).stdout.trim()).not.toBe("");
    }, 60_000);

  for (const at of ["asking", "hand-off answered", "received", "handed-off answered", "done"])
    it(`to the Mac, the Mac dying at ${at}`, async () => {
      const threadId = await macThread(agent);
      await moveUp(threadId);
      await until(settledHere);
      dieAt = { step: at, after: 0 };
      await bringHome(threadId);
      await until(() => dead || settledHere());
      await restart();
      await until(() => settledHere() && relocations.openFor(brain.db, threadId) === null);
      expect(await holders(threadId)).toEqual([{ name: "mac", ...content }]);
      // The copy this Mac kept from before the round trip was set aside under the move that replaced it, never lost.
      expect(readdirSync(path.join(root, "mac", "kept-sessions", threadId))).toHaveLength(1);
    }, 60_000);
});

/** A Mac thread working on a task: a run of it, a comment on it, and a snapshot of its work pinned in the repository. */
async function macThreadWithTask(): Promise<{ threadId: string; taskId: string }> {
  const threadId = await macThread();
  const db = mac!.db;
  const task = tasks.insert(db, { projectId: project.id, title: "Matrix task", spec: "Do it", priority: "none", labels: [], workspaceMode: "worktree", baseRef: null, parentTaskId: null, threadId });
  db.raw.prepare("UPDATE runs SET task_id = ? WHERE id = ?").run(task.id, `run-${threadId}`);
  db.raw
    .prepare("INSERT INTO task_comments (id, task_id, request_key, body, recipients, source, context, created_at) VALUES (?, ?, 'k', 'Ship it', '[]', 'user', '{}', 1)")
    .run(`c-${task.id}`, task.id);
  // As a turn's snapshot does: the worktree's files as a tree, pinned under the task's refs.
  const tree = await treeHash(threads.get(db, threadId)!.worktreePath!);
  await pinObject(checkout, `refs/openorc/snapshots/${task.id}/${tree}`, tree);
  snapshots.insert(db, { taskId: task.id, runId: `run-${threadId}`, turn: 1, treeSha: tree, diffStat: { files: 0, additions: 0, deletions: 0 } } as never);
  return { threadId, taskId: task.id };
}

/** Who holds the task, and what of it: its comment, its run still naming it, its snapshot and the snapshot's ref. */
async function taskHolders(taskId: string, threadId: string) {
  const held = [];
  for (const [name, core, repo] of [
    ["mac", mac!, checkout],
    ["brain", brain, brainCopy.rootPath],
  ] as const) {
    const task = tasks.get(core.db, taskId);
    if (!task) continue;
    const tree = (core.db.raw.prepare("SELECT tree_sha FROM snapshots WHERE task_id = ?").get(taskId) as { tree_sha: string } | undefined)?.tree_sha;
    const ref = (await git(repo, ["for-each-ref", "--format=%(objectname)", `refs/openorc/snapshots/${taskId}/`])).stdout.trim();
    held.push({
      name,
      title: task.title,
      creator: task.threadId === threadId,
      comments: (core.db.raw.prepare("SELECT body FROM task_comments WHERE task_id = ?").all(taskId) as { body: string }[]).map((row) => row.body),
      run: runs.get(core.db, `run-${threadId}`)?.taskId === taskId,
      snapshots: core.db.raw.prepare("SELECT COUNT(*) AS c FROM snapshots WHERE task_id = ?").get(taskId),
      ref: tree !== undefined && ref === tree,
    });
  }
  return held;
}

const taskContent = { title: "Matrix task", creator: true, comments: ["Ship it"], run: true, snapshots: { c: 1 }, ref: true };

describe("a crash after every step moves a thread's task with it, held by exactly one side", () => {
  for (const at of ["frozen", "sending", "receive answered", "let go", "done"])
    it(`to the cloud, the Mac dying at ${at}`, async () => {
      const { threadId, taskId } = await macThreadWithTask();
      dieAt = { step: at, after: 0 };
      await moveUp(threadId);
      // A Mac that dies after the move settles has let its copy go first, as the dying process would have.
      await until(() => dead || (settledHere() && relocations.withCleanup(mac!.db).length === 0));
      await restart();
      await until(() => settledHere() && relocations.withCleanup(mac!.db).length === 0);
      expect(await holders(threadId)).toEqual([{ name: "brain", ...content }]);
      expect(await taskHolders(taskId, threadId)).toEqual([{ name: "brain", ...taskContent }]);
    }, 60_000);

  for (const at of ["asking", "hand-off answered", "received", "handed-off answered", "done"])
    it(`to the Mac, the Mac dying at ${at}`, async () => {
      const { threadId, taskId } = await macThreadWithTask();
      await moveUp(threadId);
      await until(settledHere);
      dieAt = { step: at, after: 0 };
      await bringHome(threadId);
      await until(() => dead || settledHere());
      await restart();
      await until(() => settledHere() && relocations.openFor(brain.db, threadId) === null);
      expect(await holders(threadId)).toEqual([{ name: "mac", ...content }]);
      expect(await taskHolders(taskId, threadId)).toEqual([{ name: "mac", ...taskContent }]);
    }, 60_000);
});

describe("a task while its thread moves", () => {
  it("refuses changes until the move settles, then takes them where the task went", async () => {
    const { threadId, taskId } = await macThreadWithTask();
    holdReceives = true;
    await moveUp(threadId);
    await until(() => held.length > 0);
    const refused = await mac!.handle({ type: "rpc", id: 4, method: "tasks.update", params: { id: taskId, patch: { title: "Renamed" } } });
    expect(refused).toMatchObject({ type: "rpc.error", message: MOVING_WORDS.cloud });
    holdReceives = false;
    await Promise.all(held.map((take) => take().catch(() => undefined)));
    await until(settledHere);
    expect(tasks.get(brain.db, taskId)?.title).toBe("Matrix task");
    const renamed = await brain.handle({ type: "rpc", id: 5, method: "tasks.update", params: { id: taskId, patch: { title: "Renamed" } } });
    expect(renamed).toMatchObject({ type: "rpc.result", result: { title: "Renamed" } });
  }, 60_000);
});

describe("writes to a thread while it moves", () => {
  /** A comment on the thread's uncommitted draft, for the thread or for its task. */
  const comment = (scope: { threadId: string } | { taskId: string }) => ({
    ...scope,
    path: "draft.md",
    startLine: null,
    startSide: null,
    line: 1,
    side: "new",
    lineText: "uncommitted",
    body: "Look here",
  });
  const titles = (core: OpenOrc) => (core.db.stmt("SELECT title FROM tasks").all() as { title: string }[]).map((row) => row.title);

  it("refuses every write the package would leave behind on the Mac, in the moving words, and still answers reads", async () => {
    const { threadId, taskId } = await macThreadWithTask();
    holdReceives = true;
    await moveUp(threadId);
    await until(() => held.length > 0);
    const call = (method: string, params: unknown) => mac!.handle({ type: "rpc", id: 9, method, params } as never);
    for (const [method, params] of [
      ["tasks.create", { projectId: project.id, threadId, title: "Added while moving" }],
      ["review.comments.add", comment({ threadId })],
      ["review.comments.add", comment({ taskId })],
      ["review.commitThread", { threadId, message: "Committed while moving" }],
      ["tasks.comments.post", { taskId, body: "Posted while moving", recipients: [], requestKey: "k-moving" }],
      ["approvals.resolve", { runId: `run-${threadId}`, approvalId: "a1", decision: "allow" }],
    ] as const)
      expect({ method, reply: await call(method, params) }).toMatchObject({ method, reply: { type: "rpc.error", message: MOVING_WORDS.cloud } });
    expect(await call("threads.update", { id: threadId, patch: { seen: true } })).toMatchObject({ type: "rpc.result" });
    expect(await call("threads.get", { id: threadId })).toMatchObject({ type: "rpc.result", result: { id: threadId } });
    expect(await call("review.comments.list", { threadId })).toMatchObject({ type: "rpc.result" });
    holdReceives = false;
    await Promise.all(held.map((take) => take().catch(() => undefined)));
    await until(() => settledHere() && relocations.withCleanup(mac!.db).length === 0);
    expect(titles(mac!)).toEqual([]);
    expect(titles(brain)).toEqual(["Matrix task"]);
    expect(await taskHolders(taskId, threadId)).toEqual([{ name: "brain", ...taskContent }]);
  }, 60_000);

  it("refuses those writes on the brain while it hands the thread back", async () => {
    const { threadId, taskId } = await macThreadWithTask();
    await moveUp(threadId);
    await until(() => settledHere() && relocations.withCleanup(mac!.db).length === 0);
    dieAt = { step: "hand-off answered", after: 0 };
    await bringHome(threadId);
    await until(() => dead);
    const call = (method: string, params: unknown) => brain.handle({ type: "rpc", id: 9, method, params } as never);
    expect(await call("tasks.create", { projectId: brainCopy.id, threadId, title: "Added while moving" })).toMatchObject({ type: "rpc.error", message: MOVING_WORDS.mac });
    expect(await call("review.comments.add", comment({ threadId }))).toMatchObject({ type: "rpc.error", message: MOVING_WORDS.mac });
    await restart();
    await until(() => settledHere() && relocations.openFor(brain.db, threadId) === null);
    expect(titles(brain)).toEqual([]);
    expect(await taskHolders(taskId, threadId)).toEqual([{ name: "mac", ...taskContent }]);
  }, 60_000);
});

describe("moving a thread and waiting until it settles, as moving the brain does", () => {
  const coordinator = () => (mac as unknown as { cloudParts: { coordinator: RelocationCoordinator } }).cloudParts.coordinator;

  it("says why a thread stayed, or nothing once it is where it was sent, both ways", async () => {
    const threadId = await macThread();
    const awake = channel.awake;
    channel.awake = async () => {
      channel.awake = awake;
      throw new Error("The cloud brain did not start.");
    };
    expect(await coordinator().sendBack(threadId)).toBe("The cloud brain did not start.");
    expect(await coordinator().sendBack(threadId)).toBeNull();
    expect(await holders(threadId)).toEqual([{ name: "brain", ...content }]);
    // Not on this Mac any more: nothing to send.
    expect(await coordinator().sendBack(threadId)).toBeNull();
    await until(() => relocations.withCleanup(mac!.db).length === 0);
    macProjectOf = () => null;
    expect(await coordinator().bringHome(threadId)).toBe("This conversation's project has no copy on the Mac.");
    macProjectOf = () => project.id;
    // A move here already under way is followed, not asked again.
    coordinator().bringToMac(threadId);
    expect(await coordinator().bringHome(threadId)).toBeNull();
    expect(relocations.unsettled(mac!.db)).toEqual([]);
    expect(await holders(threadId)).toEqual([{ name: "mac", ...content }]);
    expect(await coordinator().bringHome(threadId)).toBeNull();
  }, 60_000);

  it("stops waiting on a move whose drive fails again when tried once more, with its words", async () => {
    const threadId = await macThread();
    let tries = 0;
    mac!.relocations.letGo = async () => {
      tries++;
      throw new Error("The thread's folder could not be removed.");
    };
    await expect(coordinator().sendBack(threadId)).rejects.toThrow("The thread's folder could not be removed.");
    expect(tries).toBe(2);
  }, 60_000);
});

describe("moving to the cloud", () => {
  it("leaves the thread on the Mac, unfrozen with the reason, when the brain cannot be woken", async () => {
    const threadId = await macThread();
    const awake = channel.awake;
    channel.awake = async () => {
      channel.awake = awake;
      throw new Error("The cloud brain did not start.");
    };
    await moveUp(threadId);
    await until(settledHere);
    expect(relocations.latest(mac!.db, threadId)).toMatchObject({ phase: "abandoned", error: "The cloud brain did not start." });
    expect(await holders(threadId)).toEqual([{ name: "mac", ...content }]);
  }, 60_000);

  it("leaves the thread on the Mac, unfrozen with the reason, when it cannot be packed", async () => {
    const threadId = await macThread();
    await rm(threads.get(mac!.db, threadId)!.worktreePath!, { recursive: true, force: true });
    await moveUp(threadId);
    await until(settledHere);
    expect(relocations.latest(mac!.db, threadId)).toMatchObject({ phase: "abandoned", error: expect.any(String) });
    expect(frozenMoving(mac!.db, threadId)).toBeNull();
    // Nothing reached the brain: it was not even asked to call a move off.
    expect(relocations.latest(brain.db, threadId)).toBeNull();
  }, 60_000);

  it("calls the move off on the brain when a package can no longer be made after a crash while sending", async () => {
    const threadId = await macThread();
    dieAt = { step: "sending", after: 0 };
    await moveUp(threadId);
    await until(() => dead);
    await rm(threads.get(mac!.db, threadId)!.worktreePath!, { recursive: true, force: true });
    await restart();
    await until(settledHere);
    expect(relocations.latest(mac!.db, threadId)).toMatchObject({ phase: "abandoned", error: expect.any(String) });
    expect(frozenMoving(mac!.db, threadId)).toBeNull();
    expect(relocations.latest(brain.db, threadId)).toMatchObject({ phase: "dropped" });
  }, 60_000);

  it("shows each step of a move both ways as it happens", async () => {
    const threadId = await macThread();
    watched = threadId;
    await moveUp(threadId);
    await until(settledHere);
    expect(stepsSeen).toEqual(["waking", "sending"]);
    stepsSeen = [];
    await bringHome(threadId);
    // The step reads "none" at the first brain call after the move settles, which a slow machine reaches later.
    await until(() => settledHere() && stepsSeen.at(-1) === "none");
    expect(stepsSeen).toEqual(["waking", "packing", "sending", "none"]);
  }, 60_000);

  it("shows the brain waking again when it stopped while packing a thread for this Mac", async () => {
    const threadId = await macThread();
    await moveUp(threadId);
    await until(settledHere);
    watched = threadId;
    failHandOffs = 1;
    await bringHome(threadId);
    await until(() => settledHere() && stepsSeen.at(-1) === "none");
    expect(stepsSeen).toEqual(["waking", "packing", "waking", "packing", "sending", "none"]);
  }, 60_000);

  it("logs a brain that stops mid-move once for the move, however often it is asked again", async () => {
    const threadId = await macThread();
    failReceives = 4;
    await moveUp(threadId);
    await until(settledHere);
    expect(await holders(threadId)).toEqual([{ name: "brain", ...content }]);
    expect(warnings.filter((warning) => warning.includes("did not answer a move"))).toHaveLength(1);
  }, 60_000);

  it("sends the whole branch when the brain's copy lacks the commit it builds on", async () => {
    await writeFile(path.join(checkout, "later.md"), "after the copy\n");
    await commitAll(checkout, "Later");
    main = (await git(checkout, ["rev-parse", "main"])).stdout.trim();
    const threadId = await macThread();
    await moveUp(threadId);
    await until(settledHere);
    expect(await holders(threadId)).toEqual([{ name: "brain", ...content }]);
  }, 60_000);
});

describe("a move that fails for a reason other than a lost connection", () => {
  it("settles a move to the cloud with the brain's reason when the brain fails to take it, asking once", async () => {
    const threadId = await macThread();
    let receives = 0;
    const receive = awakeBrain.receive;
    awakeBrain.receive = async (relocation, bytes) => {
      receives++;
      return receive(relocation, bytes);
    };
    // What cloudAgentEnvironment throws on Vercel for an account the brain holds without a cloud token.
    brain.cloud.place = async () => {
      throw new Error("“Work” has no token for cloud threads. Create one in Settings → Cloud.");
    };
    // The refusal's reply is lost, so the Mac asks again and hears the same.
    loseNextReply = true;
    try {
      await moveUp(threadId);
      await until(settledHere, 5_000);
    } finally {
      awakeBrain.receive = receive;
    }
    expect(relocations.latest(mac!.db, threadId)).toMatchObject({ phase: "abandoned", error: "“Work” has no token for cloud threads. Create one in Settings → Cloud." });
    expect(receives).toBe(2);
    expect(await holders(threadId)).toEqual([{ name: "mac", ...content }]);
    expect(relocations.latest(brain.db, threadId)).toMatchObject({ phase: "dropped" });
    // The conversation says so on its card, and so does the phone's question of this Mac.
    const reason = "“Work” has no token for cloud threads. Create one in Settings → Cloud.";
    const listed = (await mac!.handle({ type: "rpc", id: 9, method: "threads.get", params: { id: threadId } })) as { result: { moveRefused: unknown } };
    expect(listed.result.moveRefused).toMatchObject({ to: "cloud", reason });
    expect(await mac!.remote.device("phone", "moves.refused", {})).toEqual([{ threadId, refusal: expect.objectContaining({ to: "cloud", reason }) }]);
  }, 60_000);

  it("settles Bring to Mac with the brain's reason when it fails to pack the thread, unfrozen there", async () => {
    const threadId = await macThread();
    await moveUp(threadId);
    await until(() => settledHere() && relocations.withCleanup(mac!.db).length === 0);
    macProjectOf = () => null;
    await bringHome(threadId);
    await until(() => settledHere() && relocations.openFor(brain.db, threadId) === null, 5_000);
    expect(relocations.latest(mac!.db, threadId)).toMatchObject({ phase: "abandoned", error: "This conversation's project has no copy on the Mac." });
    expect(relocations.latest(brain.db, threadId)).toMatchObject({ phase: "stayed" });
    expect(await holders(threadId)).toEqual([{ name: "brain", ...content }]);
  }, 60_000);

  it("settles Bring to Mac with the reason when this Mac fails to take the package, leaving it in the cloud", async () => {
    const threadId = await macThread();
    await moveUp(threadId);
    await until(() => settledHere() && relocations.withCleanup(mac!.db).length === 0);
    let takes = 0;
    mac!.relocations.take = async () => {
      takes++;
      throw new Error("No space left on device");
    };
    await bringHome(threadId);
    await until(() => settledHere() && relocations.openFor(brain.db, threadId) === null, 5_000);
    expect(takes).toBe(1);
    expect(relocations.latest(mac!.db, threadId)).toMatchObject({ phase: "abandoned", error: "No space left on device" });
    expect(await holders(threadId)).toEqual([{ name: "brain", ...content }]);
  }, 60_000);

  it("keeps a thread this Mac took when a step after taking it fails, and the brain lets its copy go", async () => {
    const threadId = await macThread();
    await moveUp(threadId);
    await until(() => settledHere() && relocations.withCleanup(mac!.db).length === 0);
    const recover = mac!.threads.recoverQueue;
    mac!.threads.recoverQueue = () => {
      mac!.threads.recoverQueue = recover;
      throw new Error("The queue could not be read.");
    };
    await bringHome(threadId);
    await until(() => settledHere() && relocations.openFor(brain.db, threadId) === null, 5_000);
    expect(relocations.latest(brain.db, threadId)).toMatchObject({ phase: "left" });
    expect(await holders(threadId)).toEqual([{ name: "mac", ...content }]);
  }, 60_000);

  it("waits longer after each try that finds no brain", async () => {
    const threadId = await macThread();
    const at: number[] = [];
    const receive = awakeBrain.receive;
    awakeBrain.receive = async (relocation, bytes) => {
      at.push(Date.now());
      return receive(relocation, bytes);
    };
    failReceives = 1000;
    try {
      await moveUp(threadId);
      await until(() => at.length >= 6, 10_000);
    } finally {
      awakeBrain.receive = receive;
      failReceives = 0;
    }
    // The wait before the sixth try is sixteen retry periods of 20 ms.
    expect(at[5]! - at[4]!).toBeGreaterThanOrEqual(16 * 20);
  }, 60_000);

  it("wakes a brain it cannot reach only a few times, then tries only while the brain is up anyway", async () => {
    const threadId = await macThread();
    const awake = channel.awake;
    let naps = 0;
    channel.awake = (work, wake = true) => {
      if (!wake) naps++;
      return awake(work, wake);
    };
    try {
      [failReceives, asleep] = [1000, true];
      await moveUp(threadId);
      await until(() => naps >= 3, 10_000);
      expect(wakes).toBe(3);
      expect(frozenMoving(mac!.db, threadId)).toMatchObject({ to: "cloud" });
      // The brain woke for something else: the next try finds it up, without waking it.
      [failReceives, asleep] = [0, false];
      await until(settledHere, 10_000);
    } finally {
      channel.awake = awake;
    }
    expect(wakes).toBe(3);
    expect(await holders(threadId)).toEqual([{ name: "brain", ...content }]);
  }, 60_000);

  it("tries a waiting move again at once when this Mac's link reaches the brain", async () => {
    await mac!.close();
    await openMac(60_000);
    const threadId = await macThread();
    failReceives = 1;
    await moveUp(threadId);
    await until(() => failReceives === 0);
    // As the link does once its dial finds the brain up.
    (mac!.brainRouting!.link as unknown as { set(reach: "live"): void }).set("live");
    await until(settledHere, 10_000);
    expect(await holders(threadId)).toEqual([{ name: "brain", ...content }]);
  }, 60_000);
});

describe("a brain removed while a move was under way", () => {
  it("settles every move both ways at once when this Mac removes the brain, and closes the copies of its threads", async () => {
    const [staying, inCloud] = [await macThread(), await macThread()];
    await moveUp(inCloud);
    await until(settledHere);
    const mirrors = new BrainMirrors({
      db: mac!.db,
      dataDir: path.join(root, "mac"),
      snapshot: (id, known) => snapshotFolder(brainCopy.rootPath, threads.get(brain.db, id)!.worktreePath!, id, known),
      thread: async () => ({ projectId: brainCopy.id, baseSha: null }),
      mapping: async () => ({ toCloud: () => brainCopy.id, toMac: () => project.id }),
      changed: () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} } as never,
    });
    await mirrors.open(inCloud);
    const copy = mirrorFolder(mac!.db, inCloud)!.path;
    // Both moves wait on a brain that stopped answering, each to be tried again a minute later.
    await mac!.close();
    await openMac(60_000);
    [failReceives, failHandOffs] = [1000, 1000];
    await moveUp(staying);
    await bringHome(inCloud);
    await until(() => failReceives < 1000 && failHandOffs < 1000);
    const { awake, gone } = channel;
    channel.awake = async () => {
      throw new Error("No cloud brain is set up.");
    };
    channel.gone = async () => true;
    try {
      await mac!.handle({ type: "rpc", id: 3, method: "cloud.brain.remove", params: {} });
    } finally {
      [channel.awake, channel.gone] = [awake, gone];
    }
    expect(relocations.unsettled(mac!.db)).toEqual([]);
    expect(relocations.latest(mac!.db, staying)).toMatchObject({ phase: "abandoned", error: "The cloud brain's machine is gone." });
    expect(relocations.latest(mac!.db, inCloud)).toMatchObject({ phase: "abandoned" });
    expect((await holders(staying)).find((held) => held.name === "mac")).toEqual({ name: "mac", ...content });
    expect(mirrorFolder(mac!.db, inCloud)).toBeNull();
    expect(existsSync(copy)).toBe(false);
  }, 60_000);

  it("settles the move at the next start, leaving the thread on the Mac, unfrozen", async () => {
    const threadId = await macThread();
    dieAt = { step: "sending", after: 0 };
    await moveUp(threadId);
    await until(() => dead);
    const { awake, gone } = channel;
    resumes = false;
    channel.awake = async () => {
      throw new Error("No cloud brain is set up.");
    };
    channel.gone = async () => true;
    try {
      await restart();
      await until(settledHere);
    } finally {
      [channel.awake, channel.gone] = [awake, gone];
    }
    expect(relocations.latest(mac!.db, threadId)).toMatchObject({ phase: "abandoned" });
    expect(await holders(threadId)).toEqual([{ name: "mac", ...content }]);
  }, 60_000);
});

describe("bringing a thread to the Mac", () => {
  it("closes the thread's read-only copy here once this Mac holds the thread itself", async () => {
    const threadId = await macThread();
    await moveUp(threadId);
    await until(settledHere);
    const inCloud = threads.get(brain.db, threadId)!;
    const mirrors = new BrainMirrors({
      db: mac!.db,
      dataDir: path.join(root, "mac"),
      snapshot: (id, known) => snapshotFolder(brainCopy.rootPath, inCloud.worktreePath!, id, known),
      thread: async () => ({ projectId: brainCopy.id, baseSha: null }),
      mapping: async () => ({ toCloud: () => brainCopy.id, toMac: () => project.id }),
      changed: () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} } as never,
    });
    await mirrors.open(threadId);
    const copy = mirrorFolder(mac!.db, threadId)!.path;
    expect(existsSync(path.join(copy, "draft.md"))).toBe(true);
    await writeFile(path.join(copy, "draft.md"), "edited in the copy\n");
    await bringHome(threadId);
    await until(() => settledHere() && relocations.openFor(brain.db, threadId) === null);
    expect(await holders(threadId)).toEqual([{ name: "mac", ...content }]);
    expect(mirrorFolder(mac!.db, threadId)).toBeNull();
    expect(existsSync(copy)).toBe(false);
    // The edit made in the copy is kept aside, not lost with it.
    const kept = (await git(checkout, ["for-each-ref", "--format=%(objectname)", `refs/openorc/mirror/${threadId}/kept/`])).stdout.trim();
    expect((await git(checkout, ["show", `${kept}:draft.md`])).stdout).toBe("edited in the copy\n");
    expect((await git(checkout, ["worktree", "list", "--porcelain"])).stdout).not.toContain(copy);
  }, 60_000);

  it("brings home a thread started in the cloud, whose branch this Mac never had", async () => {
    const threadId = await threadOn(brain, brainCopy.id, brainCopy.rootPath);
    await bringHome(threadId);
    await until(() => settledHere() && relocations.openFor(brain.db, threadId) === null);
    expect(await holders(threadId)).toEqual([{ name: "mac", ...content }]);
    expect((await git(checkout, ["branch", "--list", `openorc/${threadId.slice(0, 8)}`])).stdout).toContain(threadId.slice(0, 8));
  }, 60_000);

  it("leaves it in the cloud with the reason when its branch is checked out in another folder here", async () => {
    const threadId = await macThread();
    await moveUp(threadId);
    await until(() => settledHere() && relocations.withCleanup(mac!.db).length === 0);
    await git(checkout, ["checkout", "-q", `openorc/${threadId.slice(0, 8)}`]);
    await bringHome(threadId);
    await until(() => settledHere() && relocations.openFor(brain.db, threadId) === null);
    expect(relocations.latest(mac!.db, threadId)).toMatchObject({ phase: "abandoned", error: expect.stringContaining("checked out in another folder") });
    expect(await holders(threadId)).toEqual([{ name: "brain", ...content }]);
  }, 60_000);

  it("leaves it in the cloud, unfrozen there, when this Mac cannot take it", async () => {
    const threadId = await macThread();
    await moveUp(threadId);
    await until(settledHere);
    claudeAccounts.put(brain.db, { id: "brain-only", name: "Brain only" });
    brain.db.raw.prepare("UPDATE threads SET claude_account_id = 'brain-only' WHERE id = ?").run(threadId);
    await bringHome(threadId);
    await until(() => settledHere() && relocations.openFor(brain.db, threadId) === null);
    expect(relocations.latest(mac!.db, threadId)).toMatchObject({ phase: "abandoned", error: "Its Claude account is not here." });
    expect(await holders(threadId)).toEqual([{ name: "brain", ...content }]);
  }, 60_000);
});

describe("bringing a thread to the Mac when its sandbox does not answer", () => {
  async function inCloudSandbox(): Promise<string> {
    const threadId = await macThread();
    await moveUp(threadId);
    await until(() => settledHere() && relocations.withCleanup(mac!.db).length === 0);
    await until(() => brain.cloud.get(threadId)?.state === "ready", 30_000);
    return threadId;
  }
  const sandboxOf = async (threadId: string) => (await brain.cloud.sandboxes()).filter((sandbox) => sandbox.threadId === threadId);

  it("keeps it in the cloud, sandbox and all, with the reason, when the last pull from its sandbox fails", async () => {
    const threadId = await inCloudSandbox();
    brain.cloud.sync = async () => {
      throw new Error("The sandbox did not answer.");
    };
    await bringHome(threadId);
    await until(() => settledHere() && relocations.openFor(brain.db, threadId) === null);
    expect(relocations.latest(mac!.db, threadId)).toMatchObject({ phase: "abandoned", error: "Its last changes are still in its sandbox, which did not answer. Try again in a moment." });
    expect(await holders(threadId)).toEqual([{ name: "brain", ...content }]);
    expect(await sandboxOf(threadId)).toHaveLength(1);
  }, 60_000);

  it("keeps it in the cloud when its Claude session does not come out of its sandbox", async () => {
    const threadId = await inCloudSandbox();
    const sessions = (brain.cloud as unknown as { options: { sessions: { keep(...args: unknown[]): Promise<void> } } }).options.sessions;
    sessions.keep = async () => {
      throw new Error("The session did not come.");
    };
    await bringHome(threadId);
    await until(() => settledHere() && relocations.openFor(brain.db, threadId) === null);
    expect(relocations.latest(mac!.db, threadId)).toMatchObject({ phase: "abandoned", error: "Its last changes are still in its sandbox, which did not answer. Try again in a moment." });
    expect(await holders(threadId)).toEqual([{ name: "brain", ...content }]);
  }, 60_000);

  it("brings it home with what the brain pulled last when its sandbox is gone", async () => {
    const threadId = await inCloudSandbox();
    const record = brain.cloud.get(threadId)!;
    await brain.cloud.removeSandbox(record.provider, record.sandbox);
    brain.cloud.sync = async () => {
      throw new Error("The sandbox is gone.");
    };
    await bringHome(threadId);
    await until(() => settledHere() && relocations.openFor(brain.db, threadId) === null);
    expect(await holders(threadId)).toEqual([{ name: "mac", ...content }]);
  }, 60_000);
});

describe("cleaning up after a move", () => {
  it("keeps the note of a sandbox whose delete failed, and deletes it at the next start", async () => {
    const threadId = await macThread();
    const folder = threads.get(mac!.db, threadId)!.worktreePath!;
    cloudWorkspaces.insert(mac!.db, { threadId, provider: "local", sandbox: `openorc-${threadId}` });
    const removeSandbox = mac!.cloud.removeSandbox.bind(mac!.cloud);
    let refused = 0;
    mac!.cloud.removeSandbox = async () => {
      refused++;
      throw new Error("Vercel did not answer.");
    };
    await moveUp(threadId);
    const note = () => {
      const [left] = relocations.withCleanup(mac!.db);
      return left ? (JSON.parse(relocations.cleanup(mac!.db, left)!) as { worktree: string | null }) : null;
    };
    // The worktree's part is done and noted as such, the sandbox's kept for later.
    await until(() => settledHere() && refused > 0 && note()?.worktree === null);
    expect(existsSync(folder)).toBe(false);
    expect(note()).toMatchObject({ worktree: null, sandbox: { provider: "local", name: `openorc-${threadId}` } });
    mac!.cloud.removeSandbox = removeSandbox;
    await restart();
    await until(() => relocations.withCleanup(mac!.db).length === 0);
    expect(await holders(threadId)).toEqual([{ name: "brain", ...content }]);
  }, 60_000);
});

describe("calling a move off", () => {
  it("keeps the thread on the Mac, and the brain refuses the package that arrives after", async () => {
    const threadId = await macThread();
    holdReceives = true;
    await moveUp(threadId);
    await until(() => held.length > 0);
    await mac!.handle({ type: "rpc", id: 3, method: "cloud.keep", params: { threadId } });
    holdReceives = false;
    const late = await Promise.all(held.map((take) => take()));
    expect(late.every((answer) => (answer as BrainControlResults["receive-thread"]).hasOwnProperty("refused"))).toBe(true);
    await until(settledHere);
    expect(await holders(threadId)).toEqual([{ name: "mac", ...content }]);
  }, 60_000);

  it("never unfreezes a thread whose taking the brain may have answered", async () => {
    const threadId = await macThread();
    loseNextReply = true;
    await moveUp(threadId);
    await until(settledHere);
    expect(await holders(threadId)).toEqual([{ name: "brain", ...content }]);
  }, 60_000);

  it("refuses Keep in the cloud once this Mac took the thread, even before the brain heard", async () => {
    const threadId = await macThread();
    await moveUp(threadId);
    await until(settledHere);
    dieAt = { step: "received", after: 0 };
    await bringHome(threadId);
    await until(() => dead);
    resumes = false;
    await restart();
    const kept = await mac!.handle({ type: "rpc", id: 5, method: "cloud.keep", params: { threadId } });
    expect(kept).toMatchObject({ type: "rpc.error", message: "This conversation is on this Mac already." });
    resumes = true;
    await restart();
    await until(() => settledHere() && relocations.openFor(brain.db, threadId) === null);
    expect(await holders(threadId)).toEqual([{ name: "mac", ...content }]);
  }, 60_000);

  it("says where the thread is when Keep comes after the move took it", async () => {
    const threadId = await macThread();
    await moveUp(threadId);
    await until(settledHere);
    const keptHere = await mac!.handle({ type: "rpc", id: 6, method: "cloud.keep", params: { threadId } });
    expect(keptHere).toMatchObject({ type: "rpc.error", message: "This conversation is in the cloud already." });
    await bringHome(threadId);
    await until(settledHere);
    const keptThere = await mac!.handle({ type: "rpc", id: 7, method: "cloud.keep", params: { threadId } });
    expect(keptThere).toMatchObject({ type: "rpc.error", message: "This conversation is on this Mac already." });
    expect(await holders(threadId)).toEqual([{ name: "mac", ...content }]);
  }, 60_000);

  it("says so when Keep on this Mac comes after the brain took the thread, unheard here", async () => {
    const threadId = await macThread();
    dieAt = { step: "receive answered", after: 0 };
    await moveUp(threadId);
    await until(() => dead);
    resumes = false;
    await restart();
    const kept = await mac!.handle({ type: "rpc", id: 8, method: "cloud.keep", params: { threadId } });
    expect(kept).toMatchObject({ type: "rpc.error", message: "This conversation is in the cloud already." });
    await until(settledHere);
    expect(await holders(threadId)).toEqual([{ name: "brain", ...content }]);
  }, 60_000);

  it("brings a thread back to the cloud's copy when the Mac calls it off before taking it", async () => {
    const threadId = await macThread();
    await moveUp(threadId);
    await until(settledHere);
    dieAt = { step: "hand-off answered", after: 0 };
    await bringHome(threadId);
    await until(() => dead);
    await restart();
    await mac!.handle({ type: "rpc", id: 4, method: "cloud.keep", params: { threadId } });
    await until(() => settledHere() && relocations.openFor(brain.db, threadId) === null);
    expect(await holders(threadId)).toEqual([{ name: "brain", ...content }]);
  }, 60_000);
});
