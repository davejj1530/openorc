import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrainUnavailable, LocalSandboxProvider, type BrainControlResults } from "@openorc/cloud";
import { claudeAccounts, frozenMoving, incomingMove, LedgerWriter, relocations, runs, snapshots, tasks, threads } from "@openorc/db";
import { commitAll, git, pinObject, treeHash, worktree } from "@openorc/git";
import { DEFAULT_CLAUDE_ACCOUNT, MOVING_WORDS, type Project } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import type { OpenOrcOptions } from "../options.js";
import { until } from "../test-fixtures/fake-claude.js";
import { BrainMirrors, mirrorFolder, snapshotFolder } from "./brain-mirrors.js";
import type { AwakeBrain, BrainChannel } from "./relocation-coordinator.js";

class Died extends Error {}

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
        return (await ops.handOff(request.relocation, request.threadId, outbox(), () => project.id)) as never;
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
  awake: (work) => {
    noteStep();
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
  mac = await OpenOrc.create({ dataDir: path.join(root, "mac"), transport: { push }, brainChannel: channel, relocationTiming: { retryMs, step } });
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
  [dead, dieAt, held, holdReceives, loseNextReply, resumes, failReceives, warnings, watched, stepsSeen, failHandOffs] = [false, null, [], false, false, true, 0, [], null, [], 0];
  passed.clear();
  await openMac();
  project = await mac!.projects.import(checkout);
  brain = await OpenOrc.create({
    dataDir: path.join(root, "brain"),
    ephemeral: true,
    transport: { push: () => {} },
    cloudOnly: true,
    deviceSystem: null,
    claudeCloudSecrets: tokenStore(),
    cloudSandboxes: new LocalSandboxProvider(path.join(root, "sandboxes"), () => process.env, 1500),
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

/** A Mac thread with a run of events, a commit on its own branch and a change not committed. */
const macThread = (): Promise<string> => threadOn(mac!, project.id, checkout);

/** Such a thread on either host: on the brain, one started there, whose branch this Mac never had. */
async function threadOn(core: OpenOrc, projectId: string, repo: string): Promise<string> {
  const db = core.db;
  const thread = threads.insert(db, { projectId, title: "Matrix thread", agent: "claude", model: null, mode: "act", permissionMode: "autonomous", workspaceMode: "worktree" });
  const folder = path.join(root, core === mac ? "mac" : "brain", "worktrees", thread.id);
  await worktree.add(repo, { path: folder, branch: `openorc/${thread.id.slice(0, 8)}`, startPoint: "main" });
  await writeFile(path.join(folder, "feature.md"), "committed\n");
  await commitAll(folder, "Feature");
  await writeFile(path.join(folder, "draft.md"), "uncommitted\n");
  threads.update(db, thread.id, { worktreePath: folder, branch: `openorc/${thread.id.slice(0, 8)}` });
  runs.insert(db, { id: `run-${thread.id}`, taskId: null, threadId: thread.id, agent: "claude", model: null, mode: "act", permissionMode: "autonomous" });
  runs.update(db, `run-${thread.id}`, { state: "success", endedAt: 2 });
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
    held.push({ name, frozen: frozenMoving(core.db, threadId) !== null, title: thread.title, events, feature: read("feature.md"), draft: read("draft.md") });
  }
  return held;
}

const content = { frozen: false, title: "Matrix thread", events: 5, feature: "committed\n", draft: "uncommitted\n" };
const settledHere = () => relocations.unsettled(mac!.db).length === 0;

async function moveUp(threadId: string): Promise<void> {
  await mac!.handle({ type: "rpc", id: 1, method: "cloud.move", params: { threadId } });
}

async function bringHome(threadId: string): Promise<void> {
  await mac!.handle({ type: "rpc", id: 2, method: "cloud.bringToMac", params: { threadId } });
}

describe("a crash after every step leaves exactly one owner, with the thread whole", () => {
  for (const at of ["frozen", "sending", "receive answered", "let go", "done"])
    it(`to the cloud, the Mac dying at ${at}`, async () => {
      const threadId = await macThread();
      const folder = threads.get(mac!.db, threadId)!.worktreePath!;
      dieAt = { step: at, after: 0 };
      await moveUp(threadId);
      await until(() => dead || settledHere());
      await restart();
      await until(() => settledHere() && relocations.withCleanup(mac!.db).length === 0);
      expect(await holders(threadId)).toEqual([{ name: "brain", ...content }]);
      // The Mac's worktree is retired, its last state kept on a ref of the thread's own.
      expect(existsSync(folder)).toBe(false);
      expect((await git(checkout, ["rev-parse", "--verify", "--quiet", `refs/openorc/relocated/${threadId}`], { okCodes: [0, 1] })).stdout.trim()).not.toBe("");
    }, 60_000);

  for (const at of ["asking", "hand-off answered", "received", "handed-off answered", "done"])
    it(`to the Mac, the Mac dying at ${at}`, async () => {
      const threadId = await macThread();
      await moveUp(threadId);
      await until(settledHere);
      dieAt = { step: at, after: 0 };
      await bringHome(threadId);
      await until(() => dead || settledHere());
      await restart();
      await until(() => settledHere() && relocations.openFor(brain.db, threadId) === null);
      expect(await holders(threadId)).toEqual([{ name: "mac", ...content }]);
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
      await until(() => dead || settledHere());
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
    await until(settledHere);
    expect(stepsSeen).toEqual(["waking", "packing", "sending", "none"]);
  }, 60_000);

  it("shows the brain waking again when it stopped while packing a thread for this Mac", async () => {
    const threadId = await macThread();
    await moveUp(threadId);
    await until(settledHere);
    watched = threadId;
    failHandOffs = 1;
    await bringHome(threadId);
    await until(settledHere);
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
    await bringHome(threadId);
    await until(() => settledHere() && relocations.openFor(brain.db, threadId) === null);
    expect(await holders(threadId)).toEqual([{ name: "mac", ...content }]);
    expect(mirrorFolder(mac!.db, threadId)).toBeNull();
    expect(existsSync(copy)).toBe(false);
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
