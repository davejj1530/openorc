import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeSessionFile, hostHome, packSession, unpackSession, type SessionId } from "@openorc/agents";
import { cloudMoves, Db, LedgerWriter, listEvents, projects, runs, subagents, threads } from "@openorc/db";
import { leaveWithSave, type ArrivalLine, type Hosted } from "@openorc/hosted";
import { computerNames, type AgentEvent } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessions, type AgentHomes } from "./agent-sessions.js";
import { CloudMoves } from "./cloud-moves.js";
import { WorkspaceService } from "./workspace.js";

const SESSION = "0b9f3c3e-5d2a-4f1e-9c47-2a6f0d8e1b55" as SessionId;
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "A",
  GIT_AUTHOR_EMAIL: "a@example.com",
  GIT_COMMITTER_NAME: "A",
  GIT_COMMITTER_EMAIL: "a@example.com",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

let root: string;
let db: Db;
let ledger: LedgerWriter;
let folder: string;
let claude: string;
let cli: string;
let workspaces: WorkspaceService;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-moves-")));
  // The project: a clone of "GitHub", so GitHub's copy of its base branch is here.
  const github = path.join(root, "github.git");
  git(root, "init", "-q", "--bare", "-b", "main", github);
  const seed = path.join(root, "seed");
  git(root, "clone", "-q", github, seed);
  await writeFile(path.join(seed, "README.md"), "first\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "First");
  git(seed, "push", "-q", "origin", "HEAD:main");
  folder = path.join(root, "app");
  git(root, "clone", "-q", github, folder);
  claude = path.join(root, "claude");
  cli = path.join(root, "cli");
  await writeFile(cli, `#!/bin/sh\necho "2.1.317 (stand-in)"\n`);
  await chmod(cli, 0o755);
  db = Db.memory();
  ledger = new LedgerWriter(db);
  workspaces = new WorkspaceService(db, { dataDir: path.join(root, "data") }, quiet as never);
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

const homes: AgentHomes = { here: () => hostHome({ agent: "claude", userHome: root, env: { CLAUDE_CONFIG_DIR: claude }, binary: cli, processEnv: {} }) };

/** The account as far as moves go: a Personal space, a cloud project for the folder, its threads, and what was sent. */
function account() {
  const sent = {
    /** Each time the thread's machine was asked to leave with a save, which ends what runs there. */
    asked: [] as true[],
    arrived: [] as { space: string; id: string; projectId: string }[],
    /** The title each arrival was made with. */
    titles: [] as string[],
    history: [] as ArrivalLine[],
    session: null as null | { query: { agent: string; sessionId: string; cliVersion: string; thread?: string }; packed: Uint8Array },
    /** Every conversation sent, the moving thread's and its subthreads', in order. */
    sessions: [] as { agent: string; sessionId: string; cliVersion: string; thread?: string }[],
    work: null as null | { query: Record<string, string>; bytes: number },
    done: [] as string[],
    undone: [] as string[],
    away: [] as string[],
  };
  const fail = { history: null as Error | null, movedAway: null as Error | null };
  type Row = { id: string; space: string; projectId: string; title: string; settings: { agent: "claude"; model: null; effort: null; mode: "act"; permissionMode: "trusted" } };
  const rows = new Map<string, Row>();
  const made = new Map<string, Row>();
  const leaving = new Set<string>();
  const dropped = new Map<string, Row>();
  const cloud = {
    save: null as null | { branch: string; head: string; base: string; bundle: boolean; uncommitted: boolean; savedAt: string },
    bundle: "",
    session: null as Buffer | null,
    events: [] as AgentEvent[],
    /** The server's list doesn't say yet that a thread left it, as when its word of it is still on the way. */
    slowToHear: false,
    /** Each subagent's own events, by its thread's id. */
    children: {} as Record<string, AgentEvent[]>,
    summaryProject: "",
    /** The threads started under the cloud thread, parents first, as the server lists them; and each one's conversation by id. */
    family: [] as { id: string; parentId: string; title: string; settings: Row["settings"]; createdAt: string; startedByAgent: boolean; archivedAt: string | null }[],
    sessionsOf: {} as Record<string, Buffer | null>,
    /** Whether the server moves a thread with its subthreads (`subthreadMoves`); one before it doesn't. */
    movesFamilies: true,
    /** Whether the newest save holds the folder as it is, and `asked` as the server names it (undefined: one from before it). */
    current: true,
    asked: false as boolean | undefined,
    /** A message arriving as the thread leaves keeps its folder in use: the save asked for is made, and never current. */
    stillInUse: false,
  };
  const hosted = {
    spaces: { status: () => ({ state: "ready", personalSpaceId: "personal" }) },
    threads: {
      holds: ({ thread }: { thread: string }) => rows.has(thread),
      row: (id: string) => {
        const row = rows.get(id);
        if (!row) throw new Error("That conversation isn't on OpenOrc Cloud.");
        return row;
      },
      summary: (id: string) => ({ id, projectId: cloud.summaryProject }),
      family: (id: string) => (rows.has(id) && !cloud.family.some((one) => one.id === id) ? cloud.family : []),
      cloudProjectFor: () => ({ id: "cloud-app", space: "personal" }),
      // The Mac hears a thread made on the server once it reads the server again.
      refresh: async () => {
        made.forEach((row, id) => rows.set(id, row));
        // A thread let go here that the server still has comes back with its list.
        dropped.forEach((row, id) => (leaving.has(id) ? undefined : rows.set(id, row)));
        if (!cloud.slowToHear) leaving.forEach((id) => rows.delete(id));
      },
      letGo: (id: string) => {
        if (rows.has(id)) dropped.set(id, rows.get(id)!);
        rows.delete(id);
      },
    },
    moves: {
      movesFamilies: async () => cloud.movesFamilies,
      arrive: async (space: string, input: { id: string; projectId: string; title?: string }) => (
        sent.arrived.push({ space, id: input.id, projectId: input.projectId }),
        sent.titles.push(input.title ?? ""),
        { id: input.id }
      ),
      history: async (_space: string, _id: string, lines: () => AsyncIterable<ArrivalLine>) => {
        if (fail.history) throw fail.history;
        for await (const line of lines()) sent.history.push(line);
        return { turns: sent.history.length };
      },
      session: async (_space: string, _id: string, query: { agent: string; sessionId: string; cliVersion: string; thread?: string }, packed: Uint8Array) => (
        sent.sessions.push(query),
        query.thread ? undefined : (sent.session = { query, packed }),
        { bytes: packed.length }
      ),
      work: async (_space: string, _id: string, upload: { query: Record<string, string>; chunks(): AsyncIterable<Uint8Array> }) => {
        let bytes = 0;
        for await (const chunk of upload.chunks()) bytes += chunk.length;
        sent.work = { query: upload.query, bytes };
      },
      done: async (_space: string, id: string) => {
        sent.done.push(id);
        made.set(id, { id, space: "personal", projectId: "cloud-app", title: "Moved", settings: { agent: "claude", model: null, effort: null, mode: "act", permissionMode: "trusted" } });
        return { id };
      },
      undo: async (_space: string, id: string) => void sent.undone.push(id),
      events: async function* (_space: string, id: string) {
        for (const event of cloud.children[id] ?? cloud.events) yield event;
      },
      savedSession: async (_space: string, id: string) => {
        const kept = id in cloud.sessionsOf ? cloud.sessionsOf[id] : cloud.session;
        return kept ? new Response(new Uint8Array(kept)) : new Response(null, { status: 404 });
      },
      movedAway: async (_space: string, id: string) => {
        if (fail.movedAway) throw fail.movedAway;
        sent.away.push(id);
        leaving.add(id);
      },
    },
    macProjects: {
      workSave: async () => ({ save: cloud.save, current: cloud.current, working: false, ends: [], ...(cloud.asked === undefined ? {} : { asked: cloud.asked }) }),
      ask: async () => {
        sent.asked.push(true);
        cloud.current = !cloud.stillInUse;
        return { asked: true };
      },
      // The hosted package's own wait, over this server's answers, with no time passing.
      leave: (space: string, threadId: string, ms: number) =>
        leaveWithSave(
          { workSave: () => hosted.macProjects.workSave(space, threadId), ask: () => hosted.macProjects.ask(space, threadId), withdraw: async () => {}, now: Date.now, pause: async () => {} },
          ms,
        ),
      bundle: async () => new Response(new Uint8Array(await readFile(cloud.bundle))),
    },
  } as unknown as Hosted;
  return { hosted, sent, fail, rows, cloud };
}

function moves(hosted: Hosted, deleted: string[] = [], changed: (id: string) => void = () => {}, platform = "darwin", placed: (id: string) => void = () => {}) {
  return new CloudMoves({
    db,
    hosted: () => hosted,
    sessions: new AgentSessions({ db, dataDir: path.join(root, "data"), homes }),
    ledger,
    workspaces,
    deleteThread: async (id) => {
      deleted.push(id);
      threads.delete(db, id);
    },
    changed,
    placed,
    here: computerNames(platform),
    log: quiet,
  });
}

/** A Claude thread working in the project's checkout, with one exchange and its agent's conversation on this Mac. */
async function macThread() {
  const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
  const made = threads.insert(db, { projectId: project.id, title: "Fix the login", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "current" });
  const thread = threads.update(db, made.id, { baseSha: git(folder, "rev-parse", "HEAD"), branch: "main" });
  runs.insert(db, { id: "run-1", taskId: null, threadId: thread.id, agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
  runs.update(db, "run-1", { state: "success", externalSessionId: SESSION, endedAt: Date.now() });
  ledger.push({ type: "message.completed", runId: "run-1", ts: 1_000, messageId: "user-1", role: "user", text: "Remember the word pelican" });
  ledger.push({ type: "message.completed", runId: "run-1", ts: 2_000, messageId: "assistant-1", role: "assistant", text: "Noted: pelican" });
  ledger.flush();
  const file = claudeSessionFile(claude, folder, SESSION);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ type: "user", cwd: folder, sessionId: SESSION, text: "Remember the word pelican" })}\n`);
  await writeFile(path.join(folder, "LOCAL.md"), "not committed yet\n");
  return { project, thread };
}

const settled = (id: string) => vi.waitFor(() => expect(cloudMoves.open(db, id)).toBeNull(), { timeout: 10_000 });

/** A subagent the thread's first run started: its own thread, its card in the parent's events, its own run and what it did. */
function subagentOf(parent: string, status: "running" | "completed" = "completed") {
  const made = threads.insert(db, {
    projectId: threads.get(db, parent)!.projectId,
    title: "Find the login handler",
    agent: "claude",
    model: null,
    mode: "act",
    permissionMode: "trusted",
    workspaceMode: "current",
  });
  const child = threads.update(db, made.id, { parentThreadId: parent, parentRelation: "subagent" });
  runs.insert(db, { id: "child-run", taskId: null, threadId: child.id, agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
  runs.update(db, "child-run", { state: status === "running" ? "running" : "success" });
  ledger.push({
    type: "subagent.started",
    runId: "run-1",
    ts: 1_500,
    subagentId: "agent-7",
    threadId: child.id,
    toolCallId: "toolu_7",
    title: "Find the login handler",
    prompt: "Where is login handled?",
    agentType: "Explore",
  });
  ledger.push({ type: "message.completed", runId: "child-run", ts: 1_600, messageId: "child-1", role: "assistant", text: "In src/auth/login.ts" });
  ledger.flush();
  subagents.insert(db, {
    threadId: child.id,
    runId: "child-run",
    hostRunId: "run-1",
    rootThreadId: parent,
    nativeId: "agent-7",
    toolCallId: "toolu_7",
    taskId: null,
    agentType: "Explore",
    prompt: "Where is login handled?",
    status,
    result: status === "completed" ? "In src/auth/login.ts" : null,
    startedAt: 1_500,
    endedAt: status === "completed" ? 1_700 : null,
  });
  return child;
}

describe("a thread moving from this Mac to OpenOrc Cloud", () => {
  it("carries each of its subagents as a thread of its own, with its native record, the turn it began in and what it did", async () => {
    const { thread } = await macThread();
    const child = subagentOf(thread.id);
    const { hosted, sent } = account();
    await moves(hosted).move(thread.id, false);
    await settled(thread.id);
    const [parentTurn, childLine, childTurn] = sent.history;
    expect(parentTurn).toMatchObject({ kind: "turn", thread: thread.id, events: expect.arrayContaining([expect.objectContaining({ type: "subagent.started", threadId: child.id })]) });
    expect(childLine).toEqual({
      kind: "child",
      id: child.id,
      title: "Find the login handler",
      settings: { agent: "claude", model: null, effort: null, mode: "act", permissionMode: "trusted" },
      nativeId: "agent-7",
      parentSessionId: SESSION,
      agentType: "Explore",
      toolCallId: "toolu_7",
      prompt: "Where is login handled?",
      status: "completed",
      result: "In src/auth/login.ts",
      error: null,
      parentTurnId: parentTurn!.kind === "turn" ? parentTurn!.id : null,
      startedAt: new Date(1_500).toISOString(),
      endedAt: new Date(1_700).toISOString(),
    });
    expect(childTurn).toMatchObject({ kind: "turn", thread: child.id, events: [{ type: "message.completed", role: "assistant", text: "In src/auth/login.ts" }] });
    expect(sent.done).toEqual([thread.id]);
  });

  it("reads the thread in the cloud once the cloud holds it, before its copy here goes", async () => {
    const { thread } = await macThread();
    const { hosted } = account();
    const told: { cloudHolds: boolean; here: boolean }[] = [];
    await moves(
      hosted,
      [],
      () => {},
      "darwin",
      (id) => told.push({ cloudHolds: hosted.threads.holds({ thread: id }), here: threads.get(db, id) !== null }),
    ).move(thread.id, false);
    await settled(thread.id);
    expect(told).toEqual([{ cloudHolds: true, here: true }]);
  });

  it("waits while a subagent of the thread is still working", async () => {
    const { thread } = await macThread();
    subagentOf(thread.id, "running");
    const { hosted } = account();
    expect(await moves(hosted).check(thread.id)).toEqual({ to: "cloud", can: false, reason: "The agent is still working. Move it once it stops." });
  });

  it("sends its transcript, its conversation and its folder's work under its own id, then goes from this Mac", async () => {
    const { thread } = await macThread();
    const { hosted, sent } = account();
    const deleted: string[] = [];
    const cloudMovesService = moves(hosted, deleted);
    expect(await cloudMovesService.check(thread.id)).toEqual({ to: "cloud", can: true, space: { id: "personal", personal: true } });
    expect(await cloudMovesService.move(thread.id, false)).toEqual({ started: true });
    await settled(thread.id);
    expect(sent.arrived).toEqual([{ space: "personal", id: thread.id, projectId: "cloud-app" }]);
    expect(sent.history).toMatchObject([
      { kind: "turn", thread: thread.id, message: { text: "Remember the word pelican" }, events: [{ type: "message.completed", role: "assistant", text: "Noted: pelican" }] },
    ]);
    expect(sent.history[0]!.kind === "turn" && sent.history[0]!.events[0]).not.toHaveProperty("runId");
    const session = unpackSession(Buffer.from(sent.session!.packed));
    expect(sent.session!.query).toEqual({ agent: "claude", sessionId: SESSION, cliVersion: "2.1.317" });
    expect(session.parts[0]!.bytes.toString("utf8")).toContain("Remember the word pelican");
    expect(sent.work?.query["base"]).toBe(git(folder, "rev-parse", "origin/main"));
    expect(sent.work!.bytes).toBeGreaterThan(0);
    expect(sent.done).toEqual([thread.id]);
    expect(deleted).toEqual([thread.id]);
    expect(cloudMoves.moving(db, thread.id)).toBeNull();
  });

  it("sends the folder's work of a thread with no base of its own, as one imported from a terminal", async () => {
    const { thread } = await macThread();
    threads.update(db, thread.id, { baseSha: null });
    const { hosted, sent } = account();
    await moves(hosted).move(thread.id, false);
    await settled(thread.id);
    expect(sent.work!.bytes).toBeGreaterThan(0);
    expect(sent.done).toEqual([thread.id]);
  });

  it("stays where it was, undone on the server, and says why, when a step fails", async () => {
    const { thread } = await macThread();
    const { hosted, sent, fail } = account();
    fail.history = new Error("This thread holds a bogus.event event OpenOrc Cloud doesn't read yet.");
    const deleted: string[] = [];
    const service = moves(hosted, deleted);
    await service.move(thread.id, false);
    await settled(thread.id);
    expect(sent.undone).toEqual([thread.id]);
    expect(deleted).toEqual([]);
    expect(threads.get(db, thread.id)).not.toBeNull();
    expect(cloudMoves.moving(db, thread.id)).toEqual({ to: "cloud", failed: "This thread holds a bogus.event event OpenOrc Cloud doesn't read yet." });
    service.dismiss(thread.id);
    expect(cloudMoves.moving(db, thread.id)).toBeNull();
  });

  it("picks up a move OpenOrc closed on: one the server finished goes from this Mac, one it didn't stays here, undone there", async () => {
    const { project, thread: finished } = await macThread();
    const left = threads.insert(db, { projectId: project.id, title: "Draft the notes", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "current" });
    const { hosted, sent } = account();
    await hosted.moves.done("personal", finished.id);
    cloudMoves.begin(db, { threadId: finished.id, direction: "to-cloud", projectId: project.id });
    const cut = cloudMoves.begin(db, { threadId: left.id, direction: "to-cloud", projectId: project.id });
    cloudMoves.set(db, cut.id, { phase: "sending", step: "history" });
    const deleted: string[] = [];
    await moves(hosted, deleted).resume();
    expect(deleted).toEqual([finished.id]);
    expect(sent.undone).toEqual([left.id]);
    expect(cloudMoves.moving(db, left.id)).toEqual({ to: "cloud", failed: "This move stopped when OpenOrc closed. Try again." });
  });

  /** A thread started under `parent` here, in its folder, with one exchange: by the agent when `byAgent`. */
  function startedUnder(parent: string, title: string, options: { byAgent?: boolean; archivedAt?: number; worktreePath?: string } = {}) {
    const made = threads.insert(db, { projectId: threads.get(db, parent)!.projectId, title, agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "current" });
    const child = threads.update(db, made.id, {
      parentThreadId: parent,
      parentRelation: "started",
      startedByAgent: options.byAgent ?? false,
      archivedAt: options.archivedAt ?? null,
      worktreePath: options.worktreePath ?? threads.get(db, parent)!.worktreePath,
    });
    const runId = `run-${child.id}`;
    runs.insert(db, { id: runId, taskId: null, threadId: child.id, agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
    runs.update(db, runId, { state: "success", endedAt: Date.now() });
    ledger.push({ type: "message.completed", runId, ts: 3_000, messageId: `user-${child.id}`, role: "user", text: `Ask of ${title}` });
    ledger.flush();
    return child;
  }

  it("takes the threads started under it, each after the one it was started under, and they go from this Mac with it", async () => {
    const { thread } = await macThread();
    const landing = startedUnder(thread.id, "Landing copy");
    const nested = startedUnder(landing.id, "Check the links", { byAgent: true, archivedAt: Date.parse("2026-11-18T09:00:00.000Z") });
    // A title longer than the server takes arrives cut to its length, rather than refusing the whole move.
    threads.update(db, thread.id, { title: `Fix the login ${"x".repeat(300)}` });
    // The landing subthread's own conversation with its agent, beside the thread's.
    const landingSession = "5c1d7a2e-3b4f-4c6d-8e9f-0a1b2c3d4e5f" as SessionId;
    runs.update(db, `run-${landing.id}`, { externalSessionId: landingSession });
    await writeFile(claudeSessionFile(claude, folder, landingSession), `${JSON.stringify({ type: "user", cwd: folder, sessionId: landingSession, text: "Ask of Landing copy" })}\n`);
    const { hosted, sent } = account();
    const deleted: string[] = [];
    const service = moves(hosted, deleted);
    expect(await service.check(thread.id)).toMatchObject({ to: "cloud", can: true });
    await service.move(thread.id, false);
    await settled(thread.id);
    expect(sent.history.map((line) => [line.kind, line.kind === "turn" ? line.thread : line.id])).toEqual([
      ["turn", thread.id],
      ["subthread", landing.id],
      ["turn", landing.id],
      ["subthread", nested.id],
      ["turn", nested.id],
    ]);
    expect(sent.arrived).toEqual([{ space: "personal", id: thread.id, projectId: "cloud-app" }]);
    expect(sent.titles[0]).toHaveLength(200);
    expect(sent.history[1]).toMatchObject({ parentId: thread.id, title: "Landing copy", startedByAgent: false, archivedAt: null, settings: { agent: "claude" } });
    expect(sent.history[3]).toMatchObject({ parentId: landing.id, startedByAgent: true, archivedAt: "2026-11-18T09:00:00.000Z" });
    expect(sent.sessions).toEqual([
      { agent: "claude", sessionId: SESSION, cliVersion: "2.1.317" },
      { agent: "claude", sessionId: landingSession, cliVersion: "2.1.317", thread: landing.id },
    ]);
    expect(deleted, "each subthread before the one it was started under").toEqual([nested.id, landing.id, thread.id]);
  });

  it("holds a move that would split the family: a subthread alone, in its own folder, of an agent the cloud doesn't run, or too many", async () => {
    const { thread } = await macThread();
    const { hosted } = account();
    const service = moves(hosted);
    const landing = startedUnder(thread.id, "Landing copy");
    expect(await service.check(landing.id)).toEqual({ to: "cloud", can: false, reason: "A subthread moves with the thread it was started under." });
    threads.update(db, landing.id, { worktreePath: path.join(root, "worktrees", "landing") });
    expect(await service.check(thread.id)).toEqual({ to: "cloud", can: false, reason: "A subthread of this thread works in a folder of its own, so it can't move to OpenOrc Cloud." });
    threads.update(db, landing.id, { worktreePath: null, agent: "cursor" as never });
    expect(await service.check(thread.id)).toMatchObject({ can: false, reason: expect.stringMatching(/^A subthread of this thread runs .+, which doesn't run on OpenOrc Cloud\.$/) });
    threads.update(db, landing.id, { agent: "claude" });
    for (let one = 0; one < 20; one += 1) startedUnder(landing.id, `Step ${one}`);
    expect(await service.check(thread.id)).toEqual({ to: "cloud", can: false, reason: "A thread with more than 20 subthreads can't move to OpenOrc Cloud." });
  });

  it("holds a thread with subthreads before sending anything when the server can't move them, and moves one without as before", async () => {
    const { thread } = await macThread();
    const made = account();
    made.cloud.movesFamilies = false;
    const service = moves(made.hosted);
    expect(await service.check(thread.id)).toEqual({ to: "cloud", can: true, space: { id: "personal", personal: true } });
    startedUnder(thread.id, "Landing copy");
    expect(await service.check(thread.id)).toEqual({ to: "cloud", can: false, reason: "Moving a thread with its subthreads isn't available on OpenOrc Cloud yet." });
    await expect(service.move(thread.id, false)).rejects.toThrow("Moving a thread with its subthreads isn't available on OpenOrc Cloud yet.");
    expect(made.sent.arrived).toEqual([]);
  });

  it("holds a thread that isn't the account's to move, with why", async () => {
    const { thread } = await macThread();
    const { hosted } = account();
    const service = moves(hosted);
    runs.insert(db, { id: "run-2", taskId: null, threadId: thread.id, agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
    runs.update(db, "run-2", { state: "running" });
    expect(await service.check(thread.id)).toEqual({ to: "cloud", can: false, reason: "The agent is still working. Move it once it stops." });
    runs.update(db, "run-2", { state: "success" });
    cloudMoves.begin(db, { threadId: thread.id, direction: "to-cloud", projectId: null });
    expect(await service.check(thread.id)).toEqual({ to: "cloud", can: false, reason: "Moving to OpenOrc Cloud" });
  });
});

describe("a cloud thread moving to this Mac", () => {
  /** A cloud thread of the person's own space on the project, with a save of a commit and an uncommitted edit. */
  async function cloudThread(made: ReturnType<typeof account>, project: { id: string }) {
    const id = "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
    made.rows.set(id, { id, space: "personal", projectId: "cloud-app", title: "Fix the login", settings: { agent: "claude", model: null, effort: null, mode: "act", permissionMode: "trusted" } });
    made.cloud.summaryProject = project.id;
    const cloud = path.join(root, "cloud");
    git(root, "clone", "-q", path.join(root, "github.git"), cloud);
    const base = git(cloud, "rev-parse", "HEAD");
    git(cloud, "checkout", "-q", "-b", "openorc/fix-the-login-6f1c2d3e");
    await writeFile(path.join(cloud, "FIX.md"), "committed in the cloud\n");
    git(cloud, "add", "-A");
    git(cloud, "commit", "-q", "-m", "Fix");
    await writeFile(path.join(cloud, "README.md"), "edited in the cloud, not committed\n");
    const index = { ...env, GIT_INDEX_FILE: path.join(root, "wip-index") };
    execFileSync("git", ["read-tree", "HEAD"], { cwd: cloud, env: index });
    execFileSync("git", ["add", "-A"], { cwd: cloud, env: index });
    const tree = execFileSync("git", ["write-tree"], { cwd: cloud, env: index, encoding: "utf8" }).trim();
    const wip = git(cloud, "commit-tree", tree, "-p", "HEAD", "-m", "wip");
    git(cloud, "update-ref", "refs/openorc/saved/wip", wip);
    made.cloud.bundle = path.join(root, "save.bundle");
    git(cloud, "bundle", "create", "-q", made.cloud.bundle, "refs/openorc/saved/wip", "refs/heads/openorc/fix-the-login-6f1c2d3e", `^${base}`);
    made.cloud.save = { branch: "openorc/fix-the-login-6f1c2d3e", head: git(cloud, "rev-parse", "HEAD"), base, bundle: true, uncommitted: true, savedAt: new Date().toISOString() };
    made.cloud.session = packSession({
      agent: "claude",
      format: 1,
      cliVersion: "2.1.317",
      sessionId: SESSION,
      parts: [{ name: "session.jsonl", bytes: Buffer.from(`${JSON.stringify({ type: "user", cwd: "/vercel/sandbox/repo", sessionId: SESSION, text: "In the cloud" })}\n`) }],
      meta: {},
    });
    made.cloud.events = [
      { type: "message.completed", runId: `hosted:${id}`, ts: 1_000, messageId: "user-a", role: "user", text: "Fix the login" },
      { type: "message.completed", runId: `hosted:${id}`, ts: 2_000, messageId: "agent-a", role: "assistant", text: "Fixed it" },
    ];
    return id;
  }

  it("comes with its transcript, its conversation and its work on its branch, and goes from the cloud", async () => {
    const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
    const made = account();
    const id = await cloudThread(made, project);
    // Each time the thread is said to have changed: whether it has arrived here while the Mac still reads it from the cloud.
    const both: boolean[] = [];
    const service = moves(made.hosted, [], (changed) => both.push(cloudMoves.latest(db, changed)?.phase === "done" && made.hosted.threads.holds({ thread: changed })));
    expect(await service.check(id)).toEqual({ to: "mac", can: true, ends: [] });
    await service.move(id, false);
    await settled(id);
    expect(cloudMoves.latest(db, id)).toMatchObject({ phase: "done", error: null });
    expect(both).not.toContain(true);
    expect(made.sent.away).toEqual([id]);
    const here = threads.get(db, id)!;
    expect(here).toMatchObject({ projectId: project.id, title: "Fix the login", branch: "openorc/fix-the-login-6f1c2d3e", importedFrom: `cloud:${id}` });
    const [run] = runs.listForThread(db, id);
    expect(run).toMatchObject({ state: "success", externalSessionId: SESSION });
    expect(listEvents(db, run!.id).map((event) => (event.type === "message.completed" ? `${event.role}: ${event.text}` : event.type))).toEqual(["user: Fix the login", "assistant: Fixed it"]);
    expect(await readFile(path.join(here.worktreePath!, "FIX.md"), "utf8")).toBe("committed in the cloud\n");
    expect(await readFile(path.join(here.worktreePath!, "README.md"), "utf8"), "what it had not committed is back in its files").toBe("edited in the cloud, not committed\n");
    expect(git(here.worktreePath!, "status", "--porcelain")).toBe("M README.md");
    const taken = await readFile(claudeSessionFile(claude, here.worktreePath!, SESSION), "utf8");
    expect(taken).toContain(here.worktreePath!);
  });

  it("has the thread leave its machine with a save first, and moves once that save is made, current or not", async () => {
    const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
    const made = account();
    const id = await cloudThread(made, project);
    made.cloud.current = false;
    made.cloud.stillInUse = true;
    const service = moves(made.hosted, []);
    await service.move(id, false);
    await settled(id);
    expect(cloudMoves.latest(db, id)).toMatchObject({ phase: "done", error: null });
    expect(made.sent.asked).toEqual([true]);
  });

  it("waits on a server from before `asked` until the save is current", async () => {
    const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
    const made = account();
    const id = await cloudThread(made, project);
    made.cloud.current = false;
    made.cloud.asked = undefined;
    const service = moves(made.hosted, []);
    await service.move(id, false);
    await settled(id);
    expect(cloudMoves.latest(db, id)).toMatchObject({ phase: "done", error: null });
    expect(made.sent.asked).toEqual([true]);
  });

  it("comes with the threads started under it, hung as they were there, in its folder, and only the thread is let go there", async () => {
    const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
    const made = account();
    const id = await cloudThread(made, project);
    const settings = { agent: "claude" as const, model: null, effort: null, mode: "act" as const, permissionMode: "trusted" as const };
    const landing = "1b2c3d4e-0000-4000-8000-00000000000a";
    const nested = "1b2c3d4e-0000-4000-8000-00000000000b";
    made.cloud.family = [
      { id: landing, parentId: id, title: "Landing copy", settings, createdAt: "2026-11-18T08:00:00.000Z", startedByAgent: false, archivedAt: null },
      { id: nested, parentId: landing, title: "Check the links", settings, createdAt: "2026-11-18T08:05:00.000Z", startedByAgent: true, archivedAt: "2026-11-18T09:00:00.000Z" },
    ];
    for (const one of made.cloud.family) made.rows.set(one.id, { id: one.id, space: "personal", projectId: "cloud-app", title: one.title, settings });
    made.cloud.children[landing] = [{ type: "message.completed", runId: `hosted:${landing}`, ts: 3_000, messageId: "user-l", role: "user", text: "Write the landing copy" }];
    made.cloud.children[nested] = [{ type: "message.completed", runId: `hosted:${nested}`, ts: 4_000, messageId: "user-n", role: "user", text: "Check every link" }];
    made.cloud.sessionsOf[nested] = null;
    const service = moves(made.hosted);
    expect(await service.check(id)).toMatchObject({ to: "mac", can: true });
    await service.move(id, false);
    await settled(id);
    expect(cloudMoves.latest(db, id)).toMatchObject({ phase: "done", error: null });
    const root = threads.get(db, id)!;
    expect(threads.get(db, landing)).toMatchObject({ parentThreadId: id, parentRelation: "started", startedByAgent: false, archivedAt: null, worktreePath: root.worktreePath, branch: root.branch });
    expect(threads.get(db, nested)).toMatchObject({
      parentThreadId: landing,
      parentRelation: "started",
      startedByAgent: true,
      archivedAt: Date.parse("2026-11-18T09:00:00.000Z"),
      worktreePath: root.worktreePath,
    });
    const [run] = runs.listForThread(db, landing);
    expect(listEvents(db, run!.id).map((event) => (event.type === "message.completed" ? event.text : event.type))).toEqual(["Write the landing copy"]);
    expect(runs.listForThread(db, nested)[0]).toMatchObject({ externalSessionId: null });
    expect([made.rows.has(id), made.rows.has(landing), made.rows.has(nested)], "the Mac's list lets the family go").toEqual([false, false, false]);
    expect(made.sent.away, "the server lets the family go with the thread").toEqual([id]);
  });

  it("holds a cloud thread with subthreads when its server can't move them, before its machine is asked anything", async () => {
    const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
    const made = account();
    const id = await cloudThread(made, project);
    const settings = { agent: "claude" as const, model: null, effort: null, mode: "act" as const, permissionMode: "trusted" as const };
    made.cloud.family = [{ id: "sub", parentId: id, title: "Landing copy", settings, createdAt: "2026-11-18T08:00:00.000Z", startedByAgent: false, archivedAt: null }];
    made.cloud.movesFamilies = false;
    const service = moves(made.hosted);
    expect(await service.check(id)).toEqual({ to: "mac", can: false, reason: "Moving a thread with its subthreads isn't available on OpenOrc Cloud yet." });
    await expect(service.move(id, false)).rejects.toThrow("isn't available on OpenOrc Cloud yet.");
    expect(made.sent.asked).toEqual([]);
  });

  it("holds a cloud subthread alone: it moves with the thread it was started under", async () => {
    const made = account();
    const settings = { agent: "claude" as const, model: null, effort: null, mode: "act" as const, permissionMode: "trusted" as const };
    made.rows.set("sub", { id: "sub", space: "personal", projectId: "cloud-app", title: "Landing copy", settings, relation: "started" } as never);
    expect(await moves(made.hosted).check("sub")).toEqual({ to: "mac", can: false, reason: "A subthread moves with the thread it was started under." });
  });

  it("brings each of its subagents as a thread of its own under its cloud id, with its native record and what it did", async () => {
    const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
    const made = account();
    const id = await cloudThread(made, project);
    const child = "5b1d0f0e-7a43-4c61-9a52-0b8e2f6a1c77";
    made.cloud.events.push(
      {
        type: "subagent.started",
        runId: `hosted:${id}`,
        ts: 1_500,
        subagentId: "agent-9",
        threadId: child,
        toolCallId: "toolu_9",
        title: "Read the session code",
        prompt: "How do sessions expire?",
        agentType: "Explore",
      },
      { type: "subagent.updated", runId: `hosted:${id}`, ts: 1_800, subagentId: "agent-9", threadId: child, status: "completed", result: "After 30 days" },
    );
    made.cloud.children[child] = [{ type: "message.completed", runId: `hosted:${child}`, ts: 1_700, messageId: "child-a", role: "assistant", text: "After 30 days" }];
    await moves(made.hosted).move(id, false);
    await settled(id);
    expect(cloudMoves.latest(db, id)).toMatchObject({ phase: "done", error: null });
    expect(threads.get(db, child)).toMatchObject({ parentThreadId: id, parentRelation: "subagent", title: "Read the session code" });
    const [root] = runs.listForThread(db, id);
    expect(subagents.byThread(db, child)).toMatchObject({
      rootThreadId: id,
      hostRunId: root!.id,
      nativeId: "agent-9",
      toolCallId: "toolu_9",
      agentType: "Explore",
      prompt: "How do sessions expire?",
      status: "completed",
      result: "After 30 days",
      startedAt: 1_500,
      endedAt: 1_800,
    });
    const [run] = runs.listForThread(db, child);
    expect(listEvents(db, run!.id).map((event) => (event.type === "message.completed" ? event.text : event.type))).toEqual(["After 30 days"]);
  });

  it("reads the thread here once it is whole here, before the server lets it go, and back there when the server won't", async () => {
    const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
    const made = account();
    const id = await cloudThread(made, project);
    // When every window is told to read it at its new place: whether the cloud list still holds it, whether the server
    // was told yet, and whether the thread here is the journal's received one.
    const told: { cloudHolds: boolean; serverTold: boolean; here: boolean }[] = [];
    const placed = (thread: string) =>
      told.push({ cloudHolds: made.hosted.threads.holds({ thread }), serverTold: made.sent.away.includes(thread), here: cloudMoves.cameHere(db, thread) && threads.get(db, thread) !== null });
    await moves(made.hosted, [], () => {}, "darwin", placed).move(id, false);
    await settled(id);
    expect(told).toEqual([{ cloudHolds: false, serverTold: false, here: true }]);
  });

  it("reads the thread back in the cloud when the server won't let it go", async () => {
    const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
    const made = account();
    const id = await cloudThread(made, project);
    made.fail.movedAway = new Error("OpenOrc Cloud can't be reached.");
    const holds: boolean[] = [];
    await moves(
      made.hosted,
      [],
      () => {},
      "darwin",
      (thread) => holds.push(made.hosted.threads.holds({ thread })),
    ).move(id, false);
    await settled(id);
    expect(cloudMoves.moving(db, id)).toMatchObject({ to: "mac", failed: "OpenOrc Cloud can't be reached." });
    expect(threads.get(db, id)).toBeNull();
    expect(holds, "here, then the cloud's again").toEqual([false, true]);
  });

  it("reads the thread here the moment the server lets it go, without waiting to hear of it", async () => {
    const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
    const made = account();
    const id = await cloudThread(made, project);
    made.cloud.slowToHear = true;
    await moves(made.hosted).move(id, false);
    await settled(id);
    expect(cloudMoves.latest(db, id)).toMatchObject({ phase: "done" });
    expect(made.hosted.threads.holds({ thread: id })).toBe(false);
  });

  it("comes into a worktree at its base, its conversation with it, when the cloud kept nothing beyond the base", async () => {
    const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
    const made = account();
    const id = await cloudThread(made, project);
    made.cloud.save = { ...made.cloud.save!, bundle: false, uncommitted: false };
    await moves(made.hosted).move(id, false);
    await settled(id);
    const here = threads.get(db, id)!;
    expect(git(here.worktreePath!, "rev-parse", "HEAD")).toBe(made.cloud.save.base);
    expect(await readFile(claudeSessionFile(claude, here.worktreePath!, SESSION), "utf8")).toContain(here.worktreePath!);
  });

  it("leaves a folder of the thread's with other work alone, and stays in the cloud", async () => {
    const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
    const made = account();
    const id = await cloudThread(made, project);
    const service = moves(made.hosted);
    const at = workspaces.threadPath({ id, title: "Fix the login", workspaceMode: "worktree", worktreePath: null }, project);
    await mkdir(at, { recursive: true });
    git(root, "init", "-q", at);
    await writeFile(path.join(at, "MINE.md"), "someone's own work\n");
    await service.move(id, false);
    await settled(id);
    expect(cloudMoves.moving(db, id)).toEqual({
      to: "mac",
      failed: "A folder for this thread is already where its worktree goes, with other work in it. Move that work aside, then try again.",
      folder: at,
    });
    expect(made.sent.away).toEqual([]);
    expect(threads.get(db, id)).toBeNull();
    expect(await readFile(path.join(at, "MINE.md"), "utf8")).toBe("someone's own work\n");
  });

  it("holds a thread of a team's space, with why", async () => {
    const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
    const made = account();
    const id = await cloudThread(made, project);
    made.rows.set(id, { ...made.rows.get(id)!, space: "acme" });
    expect(await moves(made.hosted).check(id)).toEqual({ to: "mac", can: false, reason: "Only a thread in your own space can move to this Mac." });
  });

  it("holds a move to this Mac whose agent CLI here can't say its version, before its cloud machine is asked anything", async () => {
    const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
    const made = account();
    const id = await cloudThread(made, project);
    made.cloud.save = { ...made.cloud.save!, savedAt: new Date(0).toISOString() };
    await writeFile(cli, "#!/bin/sh\nexit 1\n");
    const words = "Claude Code didn't say which version it is. Check it in Settings > Connections, then try again.";
    const service = moves(made.hosted);
    expect(await service.check(id)).toEqual({ to: "mac", can: false, reason: words });
    await expect(service.move(id, true)).rejects.toThrow(words);
    expect(made.sent.asked, "nothing running in the cloud was ended").toEqual([]);
    expect(made.hosted.threads.holds({ thread: id })).toBe(true);
  });

  it("names this computer as the app does where it isn't a Mac", async () => {
    const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
    const made = account();
    const id = await cloudThread(made, project);
    made.rows.set(id, { ...made.rows.get(id)!, space: "team" });
    expect(await moves(made.hosted, [], () => {}, "linux").check(id)).toEqual({ to: "mac", can: false, reason: "Only a thread in your own space can move to this computer." });
    expect(await moves(made.hosted, [], () => {}, "win32").check(id)).toEqual({ to: "mac", can: false, reason: "Only a thread in your own space can move to this PC." });
  });
});
